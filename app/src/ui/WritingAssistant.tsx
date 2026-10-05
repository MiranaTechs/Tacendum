import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Clipboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  AI_WRITING_LANGUAGES,
  AI_WRITING_HANDOFF_MAX,
  AI_WRITING_OUTPUT_MAX,
  AI_WRITING_EXTERNAL_PROVIDER_LABELS,
  AI_WRITING_EXTERNAL_URLS,
  AI_WRITING_PROVIDER_LABELS,
  type AiWritingAction,
  type AiWritingFailure,
  type AiWritingExternalProvider,
  type AiWritingMode,
  type AiWritingProvider,
  type AiWritingResult,
} from '../aiWriting';
import { getWritingConnections, getWritingRevision } from '../aiWritingService';
import { useTheme } from '../theme';
import {
  InlineError,
  OutlineButton,
  PrimaryButton,
  TextAction,
} from './primitives';
import { WritingConnection } from './WritingConnection';

export interface WritingAssistantProps {
  sourceKey: string;
  onRequest: (
    action: AiWritingAction,
    signal: AbortSignal,
  ) => Promise<AiWritingResult>;
  onReview: (text: string) => AiWritingResult;
  onUse: (text: string) => boolean;
  onClose: () => void;
}

type ViewState =
  | { phase: 'choose' }
  | { phase: 'working'; action: AiWritingAction }
  | {
      phase: 'handoff';
      action: AiWritingAction;
      provider: AiWritingExternalProvider;
      owner: number;
      sourceKey: string;
      revision: number;
      opened: boolean;
      opening: boolean;
      openError: string | null;
    }
  | {
      phase: 'review';
      action: AiWritingAction | null;
      text: string;
      revision: number;
    }
  | { phase: 'error'; action: AiWritingAction | null; message: string };

const ACTIONS: ReadonlyArray<{
  kind: 'improve' | 'shorter' | 'warmer' | 'translate';
  label: string;
  description: string;
}> = [
  {
    kind: 'improve',
    label: 'Improve',
    description: 'Make it clear and natural',
  },
  {
    kind: 'shorter',
    label: 'Shorter',
    description: 'Say the same thing with less',
  },
  {
    kind: 'warmer',
    label: 'Warmer',
    description: 'Make the tone more friendly',
  },
  {
    kind: 'translate',
    label: 'Translate',
    description: 'Write it in another language',
  },
];

function failureCopy(reason: AiWritingFailure): string {
  switch (reason) {
    case 'not_allowed':
      return 'Writing help is unavailable. Try again.';
    case 'not_configured':
      return 'Choose a writing provider first.';
    case 'invalid_request':
      return 'That draft can’t be improved. Edit it and try again.';
    case 'storage_unavailable':
      return 'Couldn’t access the saved writing key. Try again.';
    case 'authentication':
      return 'The provider rejected this API key. Update it and try again.';
    case 'rate_limited':
      return 'The writing provider is busy. Try again later.';
    case 'timeout':
      return 'The writing request timed out. Try again.';
    case 'cancelled':
      return 'The writing request was cancelled.';
    case 'stale':
      return 'The writing connection changed. Try again.';
    case 'refused':
      return 'The provider couldn’t rewrite this draft. Try a different action.';
    case 'incomplete':
      return 'The provider returned an incomplete rewrite. Try again.';
    case 'invalid_response':
      return 'The provider returned text that couldn’t be used. Try again.';
    case 'provider_unavailable':
    case 'network':
      return 'Couldn’t reach the writing provider. Try again.';
  }
}

function workingCopy(action: AiWritingAction): string {
  if (action.kind === 'shorter') return 'Making it shorter…';
  if (action.kind === 'warmer') return 'Making it warmer…';
  if (action.kind === 'translate') return 'Translating…';
  return 'Improving…';
}

function progressCopy(
  action: AiWritingAction,
  mode: AiWritingMode | null,
  externalProvider: AiWritingExternalProvider,
): string {
  return mode === 'external'
    ? `Preparing ${
        AI_WRITING_EXTERNAL_PROVIDER_LABELS[externalProvider]
      } request…`
    : workingCopy(action);
}

function actionLabel(
  action: (typeof ACTIONS)[number],
  mode: AiWritingMode | null,
): string {
  if (mode !== 'external') return action.label;
  if (action.kind === 'improve') return 'Copy rewrite request';
  if (action.kind === 'shorter') return 'Copy shorter request';
  if (action.kind === 'warmer') return 'Copy warmer request';
  return action.label;
}

export function WritingAssistant({
  sourceKey,
  onRequest,
  onReview,
  onUse,
  onClose,
}: WritingAssistantProps) {
  const t = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const mountedRef = useRef(true);
  const sourceRef = useRef(sourceKey);
  const requestIdRef = useRef(0);
  const requestRef = useRef<{
    id: number;
    controller: AbortController;
  } | null>(null);
  const connectionLoadRef = useRef(0);
  const handoffOwnerRef = useRef(0);
  const handoffOpeningRef = useRef<number | null>(null);

  const [view, setView] = useState<ViewState>({ phase: 'choose' });
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [showLanguages, setShowLanguages] = useState(false);
  const [manageConnection, setManageConnection] = useState(false);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionMode, setConnectionMode] =
    useState<AiWritingMode | null>(null);
  const [externalProvider, setExternalProvider] =
    useState<AiWritingExternalProvider>('chatgpt');
  const [provider, setProvider] = useState<AiWritingProvider | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [pastedReply, setPastedReply] = useState('');

  const retireRequest = useCallback(() => {
    requestIdRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  const retireHandoff = useCallback(() => {
    handoffOwnerRef.current += 1;
    handoffOpeningRef.current = null;
  }, []);

  const resetWriting = useCallback(() => {
    retireRequest();
    retireHandoff();
    setView({ phase: 'choose' });
    setShowLanguages(false);
    setSelectedLanguage(null);
    setPastedReply('');
  }, [retireHandoff, retireRequest]);

  const loadConnection = useCallback(async () => {
    const owner = ++connectionLoadRef.current;
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const result = await getWritingConnections();
      if (!mountedRef.current || connectionLoadRef.current !== owner) return;
      setConnectionLoading(false);
      if (result.status === 'failed') {
        setConnectionMode(null);
        setProvider(null);
        setConnectionError(
          'Couldn’t access the writing connection. Try again.',
        );
        return;
      }
      const selected = result.state.selected;
      setConnectionMode(result.state.mode);
      setExternalProvider(result.state.externalProvider);
      setProvider(
        selected && result.state.providers[selected].configured
          ? selected
          : null,
      );
    } catch {
      if (!mountedRef.current || connectionLoadRef.current !== owner) return;
      setConnectionLoading(false);
      setConnectionMode(null);
      setProvider(null);
      setConnectionError('Couldn’t access the writing connection. Try again.');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadConnection();
    return () => {
      mountedRef.current = false;
      connectionLoadRef.current += 1;
      retireRequest();
      retireHandoff();
    };
  }, [loadConnection, retireHandoff, retireRequest]);

  useLayoutEffect(() => {
    sourceRef.current = sourceKey;
    resetWriting();
  }, [resetWriting, sourceKey]);

  // Android reads the live regions below. VoiceOver has no live-region
  // equivalent, so announce the two transitions that replace its focused
  // action without echoing the private suggestion itself.
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const message =
      view.phase === 'working'
        ? progressCopy(view.action, connectionMode, externalProvider)
        : view.phase === 'handoff'
        ? view.openError
          ? null
          : view.opening
          ? `Opening ${AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]}.`
          : view.opened
          ? `Request copied. ${AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]} opened.`
          : `Request copied. Open ${AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]} to paste it.`
        : view.phase === 'review'
        ? 'Writing suggestion ready. Review before using.'
        : null;
    if (message === null) return;
    AccessibilityInfo.announceForAccessibilityWithOptions(message, {
      queue: true,
    });
  }, [connectionMode, externalProvider, view]);

  const request = useCallback(
    async (action: AiWritingAction) => {
      if (requestRef.current) return;
      retireRequest();
      retireHandoff();
      const id = ++requestIdRef.current;
      const controller = new AbortController();
      const requestSource = sourceRef.current;
      const revision = getWritingRevision();
      requestRef.current = { id, controller };
      setShowLanguages(false);
      setView({ phase: 'working', action });

      try {
        const result = await onRequest(action, controller.signal);
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestRef.current?.id !== id ||
          sourceRef.current !== requestSource
        ) {
          return;
        }
        if (getWritingRevision() !== revision) {
          requestRef.current = null;
          setView({
            phase: 'error',
            action,
            message: 'The writing connection changed. Try again.',
          });
          return;
        }
        if (result.status === 'failed') {
          requestRef.current = null;
          if (result.reason === 'cancelled') {
            setView({ phase: 'choose' });
            return;
          }
          setView({
            phase: 'error',
            action,
            message: failureCopy(result.reason),
          });
          return;
        }
        if (result.status === 'handoff') {
          const url = AI_WRITING_EXTERNAL_URLS[result.provider];
          if (
            !url || result.url !== url ||
            result.prompt.trim().length === 0 ||
            result.prompt.length > AI_WRITING_HANDOFF_MAX
          ) {
            requestRef.current = null;
            setView({
              phase: 'error',
              action,
              message: 'Couldn’t prepare the writing request. Try again.',
            });
            return;
          }
          try {
            Clipboard.setString(result.prompt);
          } catch {
            requestRef.current = null;
            setView({
              phase: 'error',
              action,
              message: 'Couldn’t copy the writing request. Try again.',
            });
            return;
          }
          if (
            !mountedRef.current ||
            controller.signal.aborted ||
            requestRef.current?.id !== id ||
            sourceRef.current !== requestSource ||
            getWritingRevision() !== revision
          ) {
            return;
          }
          requestRef.current = null;
          const owner = ++handoffOwnerRef.current;
          setView({
            phase: 'handoff',
            action,
            provider: result.provider,
            owner,
            sourceKey: requestSource,
            revision,
            opened: false,
            opening: false,
            openError: null,
          });
          return;
        }
        requestRef.current = null;
        setView({ phase: 'review', action, text: result.text, revision });
      } catch {
        if (
          !mountedRef.current ||
          controller.signal.aborted ||
          requestRef.current?.id !== id
        ) {
          return;
        }
        requestRef.current = null;
        setView({
          phase: 'error',
          action,
          message: 'Couldn’t reach the writing provider. Try again.',
        });
      }
    },
    [onRequest, retireHandoff, retireRequest],
  );

  const openHandoff = useCallback(
    async (handoff: Extract<ViewState, { phase: 'handoff' }>) => {
      if (
        !mountedRef.current ||
        handoffOwnerRef.current !== handoff.owner ||
        sourceRef.current !== handoff.sourceKey ||
        handoffOpeningRef.current !== null
      ) {
        return;
      }
      if (getWritingRevision() !== handoff.revision) {
        setView(current =>
          current.phase === 'handoff' && current.owner === handoff.owner
            ? {
                ...current,
                opening: false,
                openError:
                  'The writing connection changed. Copy a new request.',
              }
            : current,
        );
        return;
      }

      const owner = handoff.owner;
      handoffOpeningRef.current = owner;
      setView(current =>
        current.phase === 'handoff' && current.owner === owner
          ? { ...current, opening: true, openError: null }
          : current,
      );

      let failed = false;
      try {
        await Linking.openURL(AI_WRITING_EXTERNAL_URLS[handoff.provider]);
      } catch {
        failed = true;
      }
      if (handoffOpeningRef.current === owner) {
        handoffOpeningRef.current = null;
      }
      if (
        !mountedRef.current ||
        handoffOwnerRef.current !== owner ||
        sourceRef.current !== handoff.sourceKey ||
        getWritingRevision() !== handoff.revision
      ) {
        return;
      }
      setView(current =>
        current.phase === 'handoff' && current.owner === owner
          ? {
              ...current,
              opened: !failed,
              opening: false,
              openError: failed
                ? `Couldn’t open ${
                    AI_WRITING_EXTERNAL_PROVIDER_LABELS[handoff.provider]
                  }. The request is still copied.`
                : null,
            }
          : current,
      );
    },
    [],
  );

  const reviewPasted = useCallback(() => {
    if (pastedReply.trim().length === 0) return;
    retireHandoff();
    const requestSource = sourceRef.current;
    const revision = getWritingRevision();
    let result: AiWritingResult;
    try {
      result = onReview(pastedReply);
    } catch {
      result = { status: 'failed', reason: 'invalid_response' };
    }
    if (
      sourceRef.current !== requestSource ||
      getWritingRevision() !== revision
    ) {
      setPastedReply('');
      setView({
        phase: 'error',
        action: null,
        message: 'The draft changed. Try again.',
      });
      return;
    }
    if (result.status !== 'completed') {
      setView({
        phase: 'error',
        action: null,
        message:
          result.status === 'failed'
            ? failureCopy(result.reason)
            : 'That pasted reply couldn’t be used. Try again.',
      });
      return;
    }
    setPastedReply('');
    setView({ phase: 'review', action: null, text: result.text, revision });
  }, [onReview, pastedReply, retireHandoff]);

  const close = useCallback(() => {
    resetWriting();
    onClose();
  }, [onClose, resetWriting]);

  const useText = useCallback(() => {
    if (view.phase !== 'review') return;
    if (getWritingRevision() !== view.revision) {
      setView({
        phase: 'error',
        action: view.action,
        message: 'The writing connection changed. Try again.',
      });
      return;
    }
    let applied = false;
    try {
      applied = onUse(view.text);
    } catch {
      applied = false;
    }
    if (!applied) {
      setView({
        phase: 'error',
        action: view.action,
        message: 'The draft changed. Try again.',
      });
      return;
    }
    onClose();
  }, [onClose, onUse, view]);

  const maxHeight = Math.min(440, Math.max(180, windowHeight * 0.52));
  const providerLabel =
    connectionMode === 'external'
      ? AI_WRITING_EXTERNAL_PROVIDER_LABELS[externalProvider]
      : provider
      ? AI_WRITING_PROVIDER_LABELS[provider]
      : null;
  const connectionReady = connectionMode === 'external' || provider !== null;

  return (
    <View
      testID="writing-assistant"
      style={[
        styles.shell,
        {
          borderColor: t.color.lineSoft,
          backgroundColor: t.color.paperLayer,
          borderTopLeftRadius: t.radius.drawer,
          borderTopRightRadius: t.radius.drawer,
        },
      ]}
    >
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text
            accessibilityRole="header"
            style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
          >
            Improve
          </Text>
          {providerLabel && !manageConnection ? (
            <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
              {providerLabel} · {connectionMode === 'external' ? 'Manual copy & paste' : 'API key'}
            </Text>
          ) : null}
        </View>
        <TextAction label="Close" testID="writing-close" onPress={close} />
      </View>

      <ScrollView
        testID="writing-assistant-scroll"
        style={[styles.scroll, { maxHeight }]}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        {manageConnection || (!connectionLoading && !connectionReady) ? (
          <WritingConnection
            showDone={false}
            onChanged={() => {
              resetWriting();
              setManageConnection(false);
              void loadConnection();
            }}
            onDone={() => {
              setManageConnection(false);
              void loadConnection();
            }}
          />
        ) : connectionLoading ? (
          <View
            testID="writing-connection-loading"
            accessibilityLiveRegion="polite"
            accessibilityLabel="Loading writing connection"
            style={styles.working}
          >
            <ActivityIndicator color={t.color.inkMuted} />
            <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
              Loading writing connection…
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.manageRow}>
              <Text
                style={[
                  t.type.compactBody,
                  styles.grow,
                  { color: t.color.inkMuted },
                ]}
              >
                {connectionMode === 'external'
                  ? `Signing in on the ${providerLabel} website does not connect that account to Tacendum. Choose an action to copy a request. Open ${providerLabel} when you are ready, paste it there, then bring the reply back here.`
                  : `Only this draft goes to ${providerLabel}. Review before using.`}
              </Text>
              <TextAction
                label="Manage"
                testID="writing-manage"
                onPress={() => {
                  resetWriting();
                  setManageConnection(true);
                }}
              />
            </View>

            {connectionError ? (
              <InlineError
                message={connectionError}
                testID="writing-load-error"
              />
            ) : null}

            {view.phase === 'choose' ? (
              <>
                <View style={styles.actionGrid}>
                  {ACTIONS.map(action => (
                    <Pressable
                      key={action.kind}
                      testID={`writing-action-${action.kind}`}
                      accessibilityRole="button"
                      accessibilityLabel={actionLabel(action, connectionMode)}
                      accessibilityHint={
                        connectionMode === 'external'
                          ? action.kind === 'translate'
                            ? `${action.description}. Choose a language, then copy a request. Open ${providerLabel} only when you choose Open ${providerLabel}.`
                            : `${action.description}. Copies a request. Open ${providerLabel} only when you choose Open ${providerLabel}.`
                          : action.description
                      }
                      onPress={() => {
                        if (action.kind === 'translate') {
                          setShowLanguages(true);
                          return;
                        }
                        void request({ kind: action.kind });
                      }}
                      style={({ pressed }) => [
                        styles.action,
                        {
                          minHeight: t.layout.touchTarget,
                          borderRadius: t.radius.button,
                          borderColor: t.color.lineSoft,
                          backgroundColor: pressed
                            ? t.color.pineWash
                            : t.color.paperSheet,
                        },
                      ]}
                    >
                      <Text style={[t.type.button, { color: t.color.pine }]}>
                        {actionLabel(action, connectionMode)}
                      </Text>
                      <Text
                        style={[
                          t.type.compactBody,
                          { color: t.color.inkMuted },
                        ]}
                      >
                        {action.description}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {showLanguages ? (
                  <View testID="writing-languages" style={styles.languageArea}>
                    <Text
                      accessibilityRole="header"
                      style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
                    >
                      Translate to
                    </Text>
                    <View
                      accessibilityRole="radiogroup"
                      style={styles.languageGrid}
                    >
                      {AI_WRITING_LANGUAGES.map(language => {
                        const selected = selectedLanguage === language.id;
                        return (
                          <Pressable
                            key={language.id}
                            testID={`writing-language-${language.id}`}
                            accessibilityRole="radio"
                            accessibilityLabel={language.label}
                            accessibilityState={{ selected }}
                            onPress={() => setSelectedLanguage(language.id)}
                            style={({ pressed }) => [
                              styles.language,
                              {
                                minHeight: t.layout.touchTarget,
                                borderRadius: t.radius.button,
                                borderColor: selected
                                  ? t.color.pine
                                  : t.color.lineSoft,
                                backgroundColor:
                                  pressed && !selected
                                    ? t.color.paperInset
                                    : t.color.paperSheet,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                t.type.buttonCompact,
                                {
                                  color: selected
                                    ? t.color.pine
                                    : t.color.inkBody,
                                },
                              ]}
                            >
                              {language.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    <PrimaryButton
                      label={
                        connectionMode === 'external'
                          ? 'Copy translation request'
                          : 'Translate'
                      }
                      testID="writing-translate-submit"
                      disabled={!selectedLanguage}
                      onPress={() => {
                        if (!selectedLanguage) return;
                        void request({
                          kind: 'translate',
                          language:
                            selectedLanguage as (typeof AI_WRITING_LANGUAGES)[number]['id'],
                        });
                      }}
                    />
                  </View>
                ) : null}
              </>
            ) : null}

            {view.phase === 'working' ? (
              <View
                testID="writing-working"
                accessibilityLiveRegion="polite"
                accessibilityLabel={progressCopy(
                  view.action,
                  connectionMode,
                  externalProvider,
                )}
                style={styles.workingBlock}
              >
                <View style={styles.working}>
                  <ActivityIndicator color={t.color.inkMuted} />
                  <Text style={[t.type.bodyStrong, { color: t.color.inkBody }]}>
                    {progressCopy(
                      view.action,
                      connectionMode,
                      externalProvider,
                    )}
                  </Text>
                </View>
                <TextAction
                  label="Cancel"
                  testID="writing-cancel"
                  onPress={resetWriting}
                />
              </View>
            ) : null}

            {view.phase === 'handoff' ? (
              <View
                testID="writing-handoff"
                accessibilityLiveRegion="polite"
                style={styles.handoff}
              >
                <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                  Request copied
                </Text>
                <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
                  Open {AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]} when
                  you are ready, paste the request there, then return and paste
                  its reply below.
                </Text>
                <OutlineButton
                  size="compact"
                  label={
                    view.opening
                      ? `Opening ${AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]}…`
                      : `Open ${AI_WRITING_EXTERNAL_PROVIDER_LABELS[view.provider]}`
                  }
                  testID="writing-handoff-open"
                  disabled={view.opening}
                  onPress={() => void openHandoff(view)}
                />
                {view.openError ? (
                  <InlineError
                    message={view.openError}
                    testID="writing-handoff-open-error"
                    marginTop={2}
                  />
                ) : null}
              </View>
            ) : null}

            {connectionMode === 'external' &&
            view.phase !== 'working' &&
            view.phase !== 'review' ? (
              <View testID="writing-paste-area" style={styles.pasteArea}>
                <Text
                  accessibilityRole="header"
                  style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
                >
                  Paste AI reply
                </Text>
                <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
                  Tacendum never reads your clipboard. Paste the reply here,
                  review it, then choose whether to use it.
                </Text>
                <TextInput
                  testID="writing-paste-input"
                  value={pastedReply}
                  onChangeText={next => {
                    setPastedReply(next);
                    if (view.phase === 'error') setView({ phase: 'choose' });
                  }}
                  placeholder="Paste the reply"
                  placeholderTextColor={t.color.inkMuted}
                  keyboardAppearance={t.scheme}
                  selectionColor={t.color.pine}
                  cursorColor={t.color.pine}
                  accessibilityLabel="AI reply"
                  multiline
                  maxLength={AI_WRITING_OUTPUT_MAX}
                  autoCapitalize="sentences"
                  autoCorrect
                  style={[
                    styles.pasteInput,
                    t.type.message,
                    {
                      minHeight: 92,
                      borderRadius: t.radius.button,
                      borderColor: t.color.lineField,
                      backgroundColor: t.color.paperSheet,
                      color: t.color.inkStrong,
                    },
                  ]}
                />
                <PrimaryButton
                  label="Review pasted reply"
                  testID="writing-paste-review"
                  disabled={pastedReply.trim().length === 0}
                  onPress={reviewPasted}
                />
              </View>
            ) : null}

            {view.phase === 'review' ? (
              <View testID="writing-review" style={styles.review}>
                <Text
                  accessibilityRole="header"
                  accessibilityLiveRegion="polite"
                  accessibilityLabel="Writing suggestion ready. Review before using."
                  style={[t.type.bodyStrong, { color: t.color.inkStrong }]}
                >
                  Review
                </Text>
                <Text
                  selectable
                  style={[
                    t.type.message,
                    styles.result,
                    {
                      borderColor: t.color.lineSoft,
                      borderRadius: t.radius.button,
                      backgroundColor: t.color.paperSheet,
                      color: t.color.inkBody,
                    },
                  ]}
                >
                  {view.text}
                </Text>
                <PrimaryButton
                  label="Use text"
                  testID="writing-use"
                  onPress={useText}
                />
                <View style={styles.reviewActions}>
                  {view.action ? (
                    <OutlineButton
                      size="compact"
                      label="Try again"
                      testID="writing-review-retry"
                      onPress={() => void request(view.action!)}
                    />
                  ) : null}
                  <TextAction label="Keep original" onPress={close} />
                </View>
              </View>
            ) : null}

            {view.phase === 'error' ? (
              <View testID="writing-error-area">
                <InlineError message={view.message} testID="writing-error" />
                <View style={styles.errorActions}>
                  {view.action ? (
                    <OutlineButton
                      size="compact"
                      label="Retry"
                      testID="writing-retry"
                      onPress={() => void request(view.action!)}
                    />
                  ) : null}
                  <TextAction
                    label="Choose another action"
                    testID="writing-error-back"
                    onPress={resetWriting}
                  />
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderTopWidth: 1,
    minWidth: 0,
  },
  headingRow: {
    minHeight: 52,
    paddingLeft: 16,
    paddingRight: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  headingCopy: {
    minWidth: 0,
    flexShrink: 1,
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  manageRow: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 8,
  },
  grow: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  action: {
    flexBasis: 148,
    flexGrow: 1,
    minWidth: 0,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  languageArea: {
    gap: 8,
    marginTop: 16,
  },
  languageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  language: {
    minWidth: 88,
    flexGrow: 1,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  workingBlock: {
    minHeight: 116,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  working: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  handoff: {
    gap: 6,
    marginBottom: 12,
  },
  pasteArea: {
    gap: 8,
    marginTop: 14,
  },
  pasteInput: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  review: {
    gap: 10,
  },
  result: {
    borderWidth: 1,
    padding: 12,
  },
  reviewActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
  errorActions: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  },
});
