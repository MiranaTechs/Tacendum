import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  AI_QUICK_TASKS,
  AI_SAVED_TASK_MAX,
  AI_TASK_NAME_MAX,
  AI_TASK_PROMPT_MAX,
  canStartAiTask,
  normalizeAiTaskTemplate,
  sameAiTaskTarget,
  type AiQuickTaskId,
} from '../aiTasks';
import { isCurrentLocalTurnLimitExhausted } from '../aiUsage';
import * as db from '../db';
import { messaging } from '../messaging';
import { personName } from '../person';
import { timeLabel } from '../time';
import { useTheme } from '../theme';
import { InlineError, PrimaryButton, TextAction } from './primitives';
import { AiUsagePanel } from './AiUsagePanel';

const PROVIDER_COPY: Record<db.AiAgentStateRow['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
};

type TaskSelection =
  | { kind: 'quick'; id: AiQuickTaskId; name: string }
  | { kind: 'saved'; id: number; name: string };

type TemplateEditorAnchor = 'new' | 'review' | number;

interface TemplateEditorState {
  mode: 'create' | 'edit';
  anchor: TemplateEditorAnchor;
  id?: number;
  name: string;
  prompt: string;
}

const COPY = {
  title: 'AI connection',
  configured: 'Configured capabilities',
  tasksTitle: 'Quick tasks',
  tasksReady:
    'This agent reports that owner-directed tasks are configured. Each shortcut opens an editable request before anything sends.',
  tasksUnavailable:
    'Owner-directed tasks are not configured for this connection. Configure an answerer on the agent computer first.',
  tasksExhausted:
    'A current local turn limit is reached. Wait for a new host report before starting another task.',
  capabilitiesUnknown:
    'Task support is unavailable until this agent reports its configured capabilities.',
  diagnostic:
    'On the agent computer, run tacendum doctor for this account. To add owner tasks, use tacendum attend enable <account>, then install or run that account’s attend service.',
  notifyTitle: 'Routine notifications',
  notifyIntro:
    'Choose whether completed turns may alert this device. Approval requests, requests for input or review, and failures still notify. Every report remains in AI attention.',
  notifyQuietBehavior:
    'Quiet completions show the finished response once without an alert or live preview.',
  notifyIndependent:
    'Message sounds and private notification previews stay in Settings.',
  notifyAll: 'All completion alerts',
  notifyQuiet: 'Quiet completions',
  notifyUnavailable:
    'This agent has not reported configurable notifications.',
  notifyLoading: 'Loading the acknowledged setting…',
  notifyFailed: 'The notification setting wasn’t queued. Try again.',
  notifyRetryFailed: 'The pending setting wasn’t sent again. Try again.',
  reviewTitle: 'Review request',
  savedTitle: 'Saved requests',
  savedIntro:
    'Saved on this device. Saving, editing, or deleting a request does not send it.',
  savedEmpty: 'No saved requests yet.',
  savedLimit: '12 saved requests maximum.',
  savedLoadFailed: 'Saved requests could not be loaded. Try again.',
  savedWriteFailed:
    'The saved request could not be changed. It may have been removed or the agent may no longer be available.',
  savedInvalid: 'Add a name and request within the shown limits.',
  savedDeleteQuestion: 'Delete this saved request from this device?',
  projectUnavailable: 'Captured project unavailable',
  projectContext:
    'The project is context reported by the agent. Its configured answerer decides where the request runs.',
  repositoryContext:
    'Repository and branch are reported context only. The agent computer’s configured answerer decides where the request runs.',
  send: 'Send request',
  sending: 'Sending request…',
  cancel: 'Cancel',
  changed:
    'The selected agent or its reported project/capabilities changed, or its repository context moved. Review the current details and choose the task again.',
  failed:
    'The request wasn’t queued. Check that the agent answerer is configured, then try again.',
  queued: 'Request queued in this conversation. This does not mean the task ran.',
} as const;

export function AiAgentSection({
  peerId,
  state,
  preference,
  now: nowOverride,
}: {
  peerId: string;
  state: db.AiAgentStateRow | null;
  preference: db.AiNotifyPreferenceRow | null;
  /** Deterministic clock for focused tests; production advances itself. */
  now?: number;
}): React.JSX.Element | null {
  const t = useTheme();
  const hasUsableState = state !== null && state.peerId === peerId;
  const [selected, setSelected] = useState<TaskSelection | null>(null);
  const [reviewed, setReviewed] = useState<db.AiAgentStateRow | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);
  const [templates, setTemplates] = useState<db.AiTaskTemplateRow[]>([]);
  const [templateEditor, setTemplateEditor] =
    useState<TemplateEditorState | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [deleteTemplateId, setDeleteTemplateId] = useState<number | null>(null);
  const [liveNow, setLiveNow] = useState(() => Date.now());
  /** State updates cannot close a same-tick double tap. This ref is the
   * synchronous single-flight gate; the token also retires async work when
   * the selected peer changes or the section unmounts. */
  const busyRef = useRef(false);
  const notifyBusyRef = useRef(false);
  const templateBusyRef = useRef(false);
  const templateLoad = useRef(0);
  const generation = useRef(0);
  const live = useRef(true);

  useEffect(() => {
    if (nowOverride !== undefined) return;
    const timer = setInterval(() => setLiveNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [nowOverride]);

  useLayoutEffect(() => {
    live.current = hasUsableState;
    generation.current += 1;
    const startedGeneration = generation.current;
    busyRef.current = false;
    notifyBusyRef.current = false;
    templateBusyRef.current = false;
    templateLoad.current += 1;
    setSelected(null);
    setReviewed(null);
    setDraft('');
    setBusy(false);
    setError(null);
    setNote(null);
    setNotifyBusy(false);
    setNotifyError(null);
    setNotifyNote(null);
    setTemplates([]);
    setTemplateEditor(null);
    setTemplateBusy(false);
    setTemplateError(null);
    setDeleteTemplateId(null);
    if (hasUsableState) {
      const requestedLoad = ++templateLoad.current;
      void db
        .listAiTaskTemplates(peerId)
        .then(rows => {
          if (
            live.current &&
            generation.current === startedGeneration &&
            templateLoad.current === requestedLoad
          ) {
            setTemplates(rows.filter(row => row.peerId === peerId));
          }
        })
        .catch(() => {
          if (
            live.current &&
            generation.current === startedGeneration &&
            templateLoad.current === requestedLoad
          ) {
            setTemplateError(COPY.savedLoadFailed);
          }
        });
    }
    return () => {
      live.current = false;
      generation.current += 1;
      templateLoad.current += 1;
      busyRef.current = false;
      notifyBusyRef.current = false;
      templateBusyRef.current = false;
    };
  }, [hasUsableState, peerId]);

  if (!hasUsableState) return null;

  const name = personName(
    state.peerId,
    state.displayName,
    state.localName,
  );
  const now = nowOverride ?? liveNow;
  const localLimitReached = isCurrentLocalTurnLimitExhausted(
    state.usage,
    state.usageReceivedAt,
    now,
  );
  const tasksReady = canStartAiTask(state) && !localLimitReached;
  const currentPreference = preference?.peerId === peerId ? preference : null;
  const taskControlsDisabled = !tasksReady || busy || templateBusy;
  const templateAtLimit = templates.length >= AI_SAVED_TASK_MAX;
  const chooseQuick = (task: (typeof AI_QUICK_TASKS)[number]): void => {
    if (!tasksReady || busyRef.current || templateBusyRef.current) return;
    setSelected({ kind: 'quick', id: task.id, name: task.label });
    setReviewed(state);
    setDraft(task.prompt);
    setError(null);
    setNote(null);
    setTemplateEditor(null);
    setDeleteTemplateId(null);
  };
  const chooseSaved = (template: db.AiTaskTemplateRow): void => {
    if (
      !tasksReady ||
      busyRef.current ||
      templateBusyRef.current ||
      template.peerId !== peerId
    ) {
      return;
    }
    setSelected({ kind: 'saved', id: template.id, name: template.name });
    setReviewed(state);
    setDraft(template.prompt);
    setError(null);
    setNote(null);
    setTemplateEditor(null);
    setDeleteTemplateId(null);
  };
  const cancel = (): void => {
    if (busyRef.current) return;
    setSelected(null);
    setReviewed(null);
    setDraft('');
    setError(null);
    setTemplateEditor(current =>
      current?.anchor === 'review' ? null : current,
    );
  };

  const refreshTemplates = async (
    startedGeneration: number,
    requestedPeerId: string,
  ): Promise<boolean> => {
    const requestedLoad = ++templateLoad.current;
    try {
      const rows = await db.listAiTaskTemplates(requestedPeerId);
      if (
        !live.current ||
        generation.current !== startedGeneration ||
        templateLoad.current !== requestedLoad
      ) {
        return false;
      }
      setTemplates(rows.filter(row => row.peerId === requestedPeerId));
      return true;
    } catch {
      if (
        live.current &&
        generation.current === startedGeneration &&
        templateLoad.current === requestedLoad
      ) {
        setTemplates([]);
        setTemplateError(COPY.savedLoadFailed);
      }
      return false;
    }
  };

  const openNewTemplate = (): void => {
    if (templateBusyRef.current || busyRef.current || templateAtLimit) return;
    setTemplateEditor({
      mode: 'create',
      anchor: 'new',
      name: '',
      prompt: '',
    });
    setDeleteTemplateId(null);
    setTemplateError(null);
  };
  const openTemplateCopy = (): void => {
    if (
      selected === null ||
      reviewed === null ||
      templateBusyRef.current ||
      busyRef.current ||
      templateAtLimit
    ) {
      return;
    }
    setTemplateEditor({
      mode: 'create',
      anchor: 'review',
      name: selected.name,
      prompt: draft,
    });
    setDeleteTemplateId(null);
    setTemplateError(null);
  };
  const openTemplateEdit = (template: db.AiTaskTemplateRow): void => {
    if (
      templateBusyRef.current ||
      busyRef.current ||
      template.peerId !== peerId
    ) {
      return;
    }
    setTemplateEditor({
      mode: 'edit',
      anchor: template.id,
      id: template.id,
      name: template.name,
      prompt: template.prompt,
    });
    setDeleteTemplateId(null);
    setTemplateError(null);
  };
  const cancelTemplateEdit = (): void => {
    if (templateBusyRef.current) return;
    setTemplateEditor(null);
    setTemplateError(null);
  };
  const saveTemplate = async (): Promise<void> => {
    if (templateBusyRef.current || busyRef.current || templateEditor === null) {
      return;
    }
    const input = normalizeAiTaskTemplate(
      templateEditor.name,
      templateEditor.prompt,
    );
    if (input === null) {
      setTemplateError(COPY.savedInvalid);
      return;
    }
    templateBusyRef.current = true;
    const startedGeneration = generation.current;
    const requestedPeerId = peerId;
    const editorSnapshot = templateEditor;
    const stillCurrent = (): boolean =>
      live.current && generation.current === startedGeneration;
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      const at = nowOverride ?? Date.now();
      const changed =
        editorSnapshot.mode === 'edit' && editorSnapshot.id !== undefined
          ? await db.updateAiTaskTemplate(
              requestedPeerId,
              editorSnapshot.id,
              input.name,
              input.prompt,
              at,
            )
          : await db.createAiTaskTemplate(
              requestedPeerId,
              input.name,
              input.prompt,
              at,
            );
      if (!stillCurrent()) return;
      if (changed === false || changed === null) {
        setTemplateEditor(null);
        setTemplateError(COPY.savedWriteFailed);
        await refreshTemplates(startedGeneration, requestedPeerId);
        return;
      }
      setTemplateEditor(null);
      await refreshTemplates(startedGeneration, requestedPeerId);
    } catch {
      if (stillCurrent()) setTemplateError(COPY.savedWriteFailed);
    } finally {
      if (stillCurrent()) {
        templateBusyRef.current = false;
        setTemplateBusy(false);
      }
    }
  };
  const askDeleteTemplate = (template: db.AiTaskTemplateRow): void => {
    if (
      templateBusyRef.current ||
      busyRef.current ||
      template.peerId !== peerId
    ) {
      return;
    }
    setDeleteTemplateId(template.id);
    setTemplateEditor(null);
    setTemplateError(null);
  };
  const deleteTemplate = async (template: db.AiTaskTemplateRow): Promise<void> => {
    if (
      templateBusyRef.current ||
      busyRef.current ||
      deleteTemplateId !== template.id ||
      template.peerId !== peerId
    ) {
      return;
    }
    templateBusyRef.current = true;
    const startedGeneration = generation.current;
    const requestedPeerId = peerId;
    const stillCurrent = (): boolean =>
      live.current && generation.current === startedGeneration;
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      const deleted = await db.deleteAiTaskTemplate(requestedPeerId, template.id);
      if (!stillCurrent()) return;
      setDeleteTemplateId(null);
      if (selected?.kind === 'saved' && selected.id === template.id) {
        setSelected(null);
        setReviewed(null);
        setDraft('');
        setError(null);
      }
      if (!deleted) setTemplateError(COPY.savedWriteFailed);
      await refreshTemplates(startedGeneration, requestedPeerId);
    } catch {
      if (stillCurrent()) setTemplateError(COPY.savedWriteFailed);
    } finally {
      if (stillCurrent()) {
        templateBusyRef.current = false;
        setTemplateBusy(false);
      }
    }
  };
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (
      busyRef.current ||
      templateBusyRef.current ||
      reviewed === null ||
      text.length === 0
    ) {
      return;
    }
    busyRef.current = true;
    const startedGeneration = generation.current;
    const stillCurrent = (): boolean =>
      live.current && generation.current === startedGeneration;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const current = await db.getAiAgentState(peerId);
      if (!stillCurrent()) return;
      if (current === null || !sameAiTaskTarget(reviewed, current)) {
        setError(COPY.changed);
        return;
      }
      const confirmNow = nowOverride ?? Date.now();
      if (
        isCurrentLocalTurnLimitExhausted(
          current.usage,
          current.usageReceivedAt,
          confirmNow,
        )
      ) {
        setError(COPY.tasksExhausted);
        return;
      }
      // No await or state transition between this generation check and the
      // explicit target passed to sendText: a switched screen cannot send.
      if (!stillCurrent()) return;
      await messaging.sendText(peerId, text);
      if (!stillCurrent()) return;
      setSelected(null);
      setReviewed(null);
      setDraft('');
      setNote(COPY.queued);
    } catch {
      if (stillCurrent()) setError(COPY.failed);
    } finally {
      if (stillCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const changeNotificationMode = async (
    routine: db.AiRoutineNotificationMode,
  ): Promise<void> => {
    if (
      notifyBusyRef.current ||
      state.capabilities?.notifications !== true ||
      currentPreference === null ||
      (currentPreference.pendingQ === null &&
        currentPreference.effectiveRoutine === routine)
    ) {
      return;
    }
    notifyBusyRef.current = true;
    const startedGeneration = generation.current;
    const stillCurrent = (): boolean =>
      live.current && generation.current === startedGeneration;
    setNotifyBusy(true);
    setNotifyError(null);
    setNotifyNote(null);
    try {
      await messaging.setAiRoutinePreference(peerId, routine);
      if (!stillCurrent()) return;
      setNotifyNote(
        `Request queued. ${name} must acknowledge it before this changes.`,
      );
    } catch {
      if (stillCurrent()) setNotifyError(COPY.notifyFailed);
    } finally {
      if (stillCurrent()) {
        notifyBusyRef.current = false;
        setNotifyBusy(false);
      }
    }
  };
  const retryNotificationMode = async (): Promise<void> => {
    if (
      notifyBusyRef.current ||
      currentPreference?.pendingQ === null ||
      currentPreference?.pendingQ === undefined
    ) {
      return;
    }
    notifyBusyRef.current = true;
    const startedGeneration = generation.current;
    const stillCurrent = (): boolean =>
      live.current && generation.current === startedGeneration;
    setNotifyBusy(true);
    setNotifyError(null);
    setNotifyNote(null);
    try {
      await messaging.retryAiRoutinePreference(peerId);
      if (stillCurrent()) setNotifyNote('Pending request sent again.');
    } catch {
      if (stillCurrent()) setNotifyError(COPY.notifyRetryFailed);
    } finally {
      if (stillCurrent()) {
        notifyBusyRef.current = false;
        setNotifyBusy(false);
      }
    }
  };

  const renderTemplateEditor = (
    anchor: TemplateEditorAnchor,
  ): React.JSX.Element | null => {
    if (templateEditor === null || templateEditor.anchor !== anchor) return null;
    const valid =
      normalizeAiTaskTemplate(templateEditor.name, templateEditor.prompt) !== null;
    return (
      <View
        style={[
          styles.templateEditor,
          { backgroundColor: t.color.paperLayer, borderColor: t.color.lineSoft },
        ]}
        testID="peer-ai-template-editor"
      >
        <Text
          accessibilityRole="header"
          style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
        >
          {templateEditor.mode === 'edit'
            ? 'Edit saved request'
            : 'Save reusable request'}
        </Text>
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {`Name · ${AI_TASK_NAME_MAX} characters maximum`}
        </Text>
        <TextInput
          maxLength={AI_TASK_NAME_MAX}
          value={templateEditor.name}
          onChangeText={value =>
            setTemplateEditor(current =>
              current ? { ...current, name: value } : current,
            )
          }
          editable={!templateBusy}
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          placeholder="Request name"
          placeholderTextColor={t.color.inkMuted}
          accessibilityLabel="Saved request name"
          testID="peer-ai-template-name"
          style={[
            t.type.input,
            styles.singleLineInput,
            {
              minHeight: t.layout.touchTarget,
              color: t.color.inkBody,
              backgroundColor: t.color.paperSheet,
              borderColor: t.color.lineStrong,
            },
          ]}
        />
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {`Request · ${AI_TASK_PROMPT_MAX.toLocaleString()} characters maximum`}
        </Text>
        <TextInput
          multiline
          maxLength={AI_TASK_PROMPT_MAX}
          value={templateEditor.prompt}
          onChangeText={value =>
            setTemplateEditor(current =>
              current ? { ...current, prompt: value } : current,
            )
          }
          editable={!templateBusy}
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          placeholder="Request to review before sending"
          placeholderTextColor={t.color.inkMuted}
          accessibilityLabel="Saved request text"
          testID="peer-ai-template-prompt"
          style={[
            t.type.body,
            styles.input,
            {
              minHeight: 120,
              color: t.color.inkBody,
              backgroundColor: t.color.paperSheet,
              borderColor: t.color.lineStrong,
            },
          ]}
        />
        {templateError ? (
          <InlineError message={templateError} testID="peer-ai-template-error" />
        ) : null}
        <PrimaryButton
          label={templateEditor.mode === 'edit' ? 'Save changes' : 'Save request'}
          busy={templateBusy}
          busyLabel="Saving request…"
          disabled={!valid}
          onPress={() => void saveTemplate()}
          testID="peer-ai-template-save"
        />
        <View style={styles.cancel}>
          <TextAction
            label={COPY.cancel}
            onPress={cancelTemplateEdit}
            disabled={templateBusy}
            testID="peer-ai-template-cancel"
          />
        </View>
      </View>
    );
  };

  const reviewPanel =
    selected !== null && reviewed !== null ? (
      <View
        style={[
          styles.review,
          { backgroundColor: t.color.paperLayer, borderColor: t.color.lineSoft },
        ]}
        testID="peer-ai-task-review"
      >
        <Text
          accessibilityRole="header"
          style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
        >
          {COPY.reviewTitle}
        </Text>
        <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
          {`Selected agent · ${name} (${PROVIDER_COPY[reviewed.provider]})`}
        </Text>
        <Text
          numberOfLines={2}
          style={[t.type.compactBody, { color: t.color.inkBody }]}
          testID="peer-ai-task-project"
        >
          {reviewed.project
            ? `Captured project · ${reviewed.project}`
            : COPY.projectUnavailable}
        </Text>
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {COPY.projectContext}
        </Text>
        {(
          [
            ['repository', 'Repository'],
            ['branch', 'Branch'],
          ] as const
        ).map(([field, label]) => {
          const context = reviewed.context;
          const value =
            context?.availability === 'captured' ||
            context?.availability === 'stale'
              ? context[field]
              : undefined;
          const status = value
            ? context?.availability === 'stale'
              ? 'Stale'
              : 'Available'
            : 'Unknown';
          return (
            <View key={field} style={styles.contextFact}>
              <Text
                style={[t.type.compactStrong, { color: t.color.inkMuted }]}
                testID={`peer-ai-task-${field}-status`}
              >
                {`${label} · ${status}`}
              </Text>
              {value ? (
                <Text
                  selectable
                  style={[t.type.utilityData, { color: t.color.inkBody }]}
                  testID={`peer-ai-task-${field}`}
                >
                  {value}
                </Text>
              ) : null}
            </View>
          );
        })}
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          {COPY.repositoryContext}
        </Text>
        <TextInput
          multiline
          maxLength={AI_TASK_PROMPT_MAX}
          value={draft}
          onChangeText={setDraft}
          editable={!busy}
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          placeholderTextColor={t.color.inkMuted}
          accessibilityLabel="Request to send"
          testID="peer-ai-task-input"
          style={[
            t.type.body,
            styles.input,
            {
              minHeight: 120,
              color: t.color.inkBody,
              backgroundColor: t.color.paperSheet,
              borderColor: t.color.lineStrong,
            },
          ]}
        />
        {error ? <InlineError message={error} testID="peer-ai-task-error" /> : null}
        <PrimaryButton
          label={COPY.send}
          busy={busy}
          busyLabel={COPY.sending}
          disabled={draft.trim().length === 0}
          onPress={() => void send()}
          testID="peer-ai-task-send"
        />
        <View style={styles.reviewActions}>
          <TextAction
            label="Save as reusable"
            onPress={openTemplateCopy}
            disabled={busy || templateBusy || templateAtLimit}
            testID="peer-ai-task-save-reusable"
          />
          <TextAction
            label={COPY.cancel}
            onPress={cancel}
            disabled={busy}
            testID="peer-ai-task-cancel"
          />
        </View>
        {renderTemplateEditor('review')}
      </View>
    ) : null;

  return (
    <View style={styles.section} testID="peer-ai-section">
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {COPY.title}
      </Text>
      <View style={styles.headingLine}>
        <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
          {PROVIDER_COPY[state.provider]}
        </Text>
        <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
          {COPY.configured}
        </Text>
      </View>
      <Text
        style={[t.type.timeStatus, styles.line, { color: t.color.inkMuted }]}
        testID="peer-ai-last-checked"
      >
        {state.capabilitiesReceivedAt === null
          ? 'Last checked unavailable'
          : `Last checked ${timeLabel(state.capabilitiesReceivedAt)}`}
      </Text>
      <View style={styles.capabilityList} testID="peer-ai-capabilities">
        {(
          [
            ['Notifications', state.capabilities?.notifications],
            ['Approval requests', state.capabilities?.approvals],
            ['Owner tasks', state.capabilities?.tasks],
          ] as const
        ).map(([label, configured]) => (
          <Text
            key={label}
            style={[t.type.compactBody, { color: t.color.inkBody }]}
          >
            {`${label} · ${
              configured === undefined
                ? 'Not reported'
                : configured
                  ? 'Configured'
                  : 'Unavailable'
            }`}
          </Text>
        ))}
      </View>
      <Text style={[t.type.compactBody, styles.line, { color: t.color.inkBody }]}>
        {state.capabilities === null
          ? COPY.capabilitiesUnknown
          : localLimitReached
            ? COPY.tasksExhausted
            : tasksReady
              ? COPY.tasksReady
              : COPY.tasksUnavailable}
      </Text>

      <Text
        accessibilityRole="header"
        style={[t.type.bodyStrong, styles.subhead, { color: t.color.inkStrong }]}
      >
        {COPY.notifyTitle}
      </Text>
      <Text style={[t.type.compactBody, styles.line, { color: t.color.inkBody }]}>
        {COPY.notifyIntro}
      </Text>
      {state.capabilities?.notifications === true ? (
        <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
          {COPY.notifyQuietBehavior}
        </Text>
      ) : null}
      {state.capabilities?.notifications === true ? (
        currentPreference === null ? (
          <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
            {COPY.notifyLoading}
          </Text>
        ) : (
          <>
            <View style={styles.notifyChoices}>
              {(
                [
                  ['all', COPY.notifyAll],
                  ['quiet', COPY.notifyQuiet],
                ] as const
              ).map(([routine, label]) => {
                const active = currentPreference.effectiveRoutine === routine;
                return (
                  <Pressable
                    key={routine}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active, disabled: notifyBusy }}
                    disabled={notifyBusy}
                    onPress={() => void changeNotificationMode(routine)}
                    testID={`peer-ai-notify-${routine}`}
                    style={({ pressed }) => [
                      styles.notifyChoice,
                      {
                        minHeight: t.layout.touchTarget,
                        borderColor: active ? t.color.pineLine : t.color.lineSoft,
                        backgroundColor: active
                          ? t.color.pineWash
                          : pressed
                            ? t.color.paperInset
                            : t.color.paperSheet,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        t.type.compactStrong,
                        { color: active ? t.color.pine : t.color.inkBody },
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {currentPreference.pendingQ !== null &&
            currentPreference.requestedRoutine !== null ? (
              <View style={styles.pendingPreference}>
                <Text
                  style={[t.type.compactBody, { color: t.color.warningInk }]}
                  testID="peer-ai-notify-pending"
                >
                  {`Waiting for ${name} to apply ${
                    currentPreference.requestedRoutine === 'quiet'
                      ? COPY.notifyQuiet
                      : COPY.notifyAll
                  }.`}
                </Text>
                <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                  The agent must be listening to apply this setting. On its
                  computer, run tacendum doctor and follow the listener setup
                  instructions.
                </Text>
                <TextAction
                  label="Send again"
                  disabled={notifyBusy}
                  onPress={() => void retryNotificationMode()}
                  testID="peer-ai-notify-retry"
                />
              </View>
            ) : currentPreference.acknowledgedAt !== null ? (
              <Text
                style={[t.type.timeStatus, styles.line, { color: t.color.pine }]}
                testID="peer-ai-notify-applied"
              >
                {`Applied by agent · ${timeLabel(
                  currentPreference.acknowledgedAt,
                )}`}
              </Text>
            ) : null}
          </>
        )
      ) : (
        <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
          {COPY.notifyUnavailable}
        </Text>
      )}
      <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
        {COPY.notifyIndependent}
      </Text>
      {notifyError ? (
        <InlineError message={notifyError} testID="peer-ai-notify-error" />
      ) : null}
      {notifyNote ? (
        <Text
          style={[t.type.compactBody, styles.line, { color: t.color.pine }]}
          testID="peer-ai-notify-note"
        >
          {notifyNote}
        </Text>
      ) : null}

      <View style={styles.usage}>
        <AiUsagePanel
          usage={state.usage}
          receivedAt={state.usageReceivedAt}
          now={now}
          compact
        />
      </View>

      <Text
        accessibilityRole="header"
        style={[t.type.bodyStrong, styles.subhead, { color: t.color.inkStrong }]}
      >
        {COPY.tasksTitle}
      </Text>
      <View style={styles.taskList}>
        {AI_QUICK_TASKS.map(task => (
          <Pressable
            key={task.id}
            accessibilityRole="button"
            accessibilityLabel={task.label}
            accessibilityState={{ disabled: taskControlsDisabled }}
            disabled={taskControlsDisabled}
            onPress={() => chooseQuick(task)}
            testID={`peer-ai-task-${task.id}`}
            style={({ pressed }) => [
              styles.task,
              {
                minHeight: t.layout.touchTarget,
                borderColor: t.color.lineSoft,
                backgroundColor: taskControlsDisabled
                  ? t.color.paperInset
                  : pressed
                    ? t.color.pineWash
                    : t.color.paperSheet,
              },
            ]}
          >
            <Text
              style={[
                t.type.compactStrong,
                { color: taskControlsDisabled ? t.color.inkMuted : t.color.pine },
              ]}
            >
              {task.label}
            </Text>
            <Text
              allowFontScaling={false}
              importantForAccessibility="no"
              accessibilityElementsHidden
              style={[t.type.iconGlyph, { color: t.color.pine }]}
            >
              ›
            </Text>
          </Pressable>
        ))}
      </View>
      {selected?.kind === 'quick' ? reviewPanel : null}
      {state.capabilities?.tasks !== true ? (
        <Text
          selectable
          style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}
          testID="peer-ai-setup-command"
        >
          {COPY.diagnostic}
        </Text>
      ) : null}

      <View style={styles.savedHeading}>
        <Text
          accessibilityRole="header"
          style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
        >
          {COPY.savedTitle}
        </Text>
        <TextAction
          label="New saved request"
          onPress={openNewTemplate}
          disabled={templateBusy || busy || templateAtLimit}
          testID="peer-ai-saved-new"
        />
      </View>
      <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
        {COPY.savedIntro}
      </Text>
      {templateAtLimit ? (
        <Text
          style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}
          testID="peer-ai-saved-limit"
        >
          {COPY.savedLimit}
        </Text>
      ) : null}
      {renderTemplateEditor('new')}
      {templateError && templateEditor === null ? (
        <InlineError message={templateError} testID="peer-ai-template-error" />
      ) : null}
      {templates.length === 0 ? (
        <Text style={[t.type.compactBody, styles.line, { color: t.color.inkMuted }]}>
          {COPY.savedEmpty}
        </Text>
      ) : (
        <View style={styles.savedList} testID="peer-ai-saved-list">
          {templates.map(template => {
            const selectedHere =
              selected?.kind === 'saved' && selected.id === template.id;
            return (
              <View
                key={template.id}
                style={[styles.savedCard, { borderColor: t.color.lineSoft }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Use saved request ${template.name}`}
                  accessibilityState={{ disabled: taskControlsDisabled }}
                  disabled={taskControlsDisabled}
                  onPress={() => chooseSaved(template)}
                  testID={`peer-ai-saved-${template.id}`}
                  style={({ pressed }) => [
                    styles.savedUse,
                    {
                      minHeight: t.layout.touchTarget,
                      backgroundColor: taskControlsDisabled
                        ? t.color.paperInset
                        : pressed
                          ? t.color.pineWash
                          : t.color.paperSheet,
                    },
                  ]}
                >
                  <Text
                    style={[
                      t.type.compactStrong,
                      styles.savedName,
                      {
                        color: taskControlsDisabled
                          ? t.color.inkMuted
                          : t.color.pine,
                      },
                    ]}
                  >
                    {template.name}
                  </Text>
                  <Text
                    allowFontScaling={false}
                    importantForAccessibility="no"
                    accessibilityElementsHidden
                    style={[t.type.iconGlyph, { color: t.color.pine }]}
                  >
                    ›
                  </Text>
                </Pressable>
                <View style={styles.savedActions}>
                  <TextAction
                    label="Edit"
                    onPress={() => openTemplateEdit(template)}
                    disabled={templateBusy || busy}
                    testID={`peer-ai-saved-edit-${template.id}`}
                  />
                  <TextAction
                    label="Delete"
                    tone="danger"
                    onPress={() => askDeleteTemplate(template)}
                    disabled={templateBusy || busy}
                    testID={`peer-ai-saved-delete-${template.id}`}
                  />
                </View>
                {deleteTemplateId === template.id ? (
                  <View
                    style={[
                      styles.deleteConfirm,
                      { backgroundColor: t.color.paperLayer },
                    ]}
                  >
                    <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
                      {COPY.savedDeleteQuestion}
                    </Text>
                    <View style={styles.savedActions}>
                      <TextAction
                        label="Delete saved request"
                        tone="danger"
                        onPress={() => void deleteTemplate(template)}
                        disabled={templateBusy}
                        testID={`peer-ai-saved-delete-confirm-${template.id}`}
                      />
                      <TextAction
                        label={COPY.cancel}
                        onPress={() => setDeleteTemplateId(null)}
                        disabled={templateBusy}
                        testID={`peer-ai-saved-delete-cancel-${template.id}`}
                      />
                    </View>
                  </View>
                ) : null}
                {renderTemplateEditor(template.id)}
                {selectedHere ? reviewPanel : null}
              </View>
            );
          })}
        </View>
      )}
      {note ? (
        <Text style={[t.type.compactBody, styles.line, { color: t.color.pine }]} testID="peer-ai-task-note">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 28 },
  headingLine: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  line: { marginTop: 8 },
  capabilityList: { marginTop: 10, gap: 4 },
  subhead: { marginTop: 20 },
  usage: { marginTop: 16 },
  notifyChoices: {
    marginTop: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  notifyChoice: {
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingPreference: { marginTop: 8, alignItems: 'flex-start' },
  taskList: { marginTop: 8, gap: 8 },
  task: {
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  savedHeading: {
    marginTop: 20,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  savedList: { marginTop: 8, gap: 10 },
  savedCard: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  savedUse: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  savedName: { flexShrink: 1 },
  savedActions: {
    paddingHorizontal: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  deleteConfirm: { padding: 8, gap: 4 },
  templateEditor: {
    marginTop: 10,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  singleLineInput: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  review: {
    marginTop: 16,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  contextFact: { gap: 3 },
  reviewActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: 4,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  cancel: { alignItems: 'center' },
});
