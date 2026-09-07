import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AppStateStatus,
} from 'react-native';
import {
  AI_WRITING_EXTERNAL_PROVIDER_LABELS,
  AI_WRITING_EXTERNAL_PROVIDERS,
  AI_WRITING_PROVIDER_LABELS,
  AI_WRITING_PROVIDERS,
  type AiWritingConnectionFailure,
  type AiWritingConnectionState,
  type AiWritingExternalProvider,
  type AiWritingMode,
  type AiWritingProvider,
} from '../aiWriting';
import {
  getWritingConnections,
  removeWritingConnection,
  saveWritingConnection,
  selectExternalWritingProvider,
  selectWritingProvider,
} from '../aiWritingService';
import { useTheme } from '../theme';
import {
  InlineError,
  OutlineButton,
  PrimaryButton,
  TextAction,
} from './primitives';

export interface WritingConnectionProps {
  onDone?: () => void;
  onChanged?: () => void;
  /** Settings has a local Done action; an enclosing assistant already has Close. */
  showDone?: boolean;
}

type Mutation = 'save' | 'select' | 'remove' | 'external';

function failureCopy(reason: AiWritingConnectionFailure): string {
  switch (reason) {
    case 'not_allowed':
      return 'Writing connections are unavailable. Try again.';
    case 'invalid_key':
      return 'Enter a valid API key.';
    case 'not_configured':
      return 'That provider no longer has a saved key.';
    case 'stale':
      return 'The writing connection changed. Try again.';
    case 'storage_unavailable':
      return 'Couldn’t access secure storage. Try again.';
  }
}

export function WritingConnection({
  onDone,
  onChanged,
  showDone = true,
}: WritingConnectionProps) {
  const t = useTheme();
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const mutationOwnerRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onDone, onChanged });
  callbacksRef.current = { onDone, onChanged };

  const [connections, setConnections] =
    useState<AiWritingConnectionState | null>(null);
  const [mode, setMode] = useState<AiWritingMode>('external');
  const [externalProvider, setExternalProvider] =
    useState<AiWritingExternalProvider>('chatgpt');
  const [provider, setProvider] = useState<AiWritingProvider>('openai');
  const [key, setKey] = useState('');
  const [showKeyEntry, setShowKeyEntry] = useState(true);
  const [busy, setBusy] = useState<{
    mutation: Mutation;
    provider: AiWritingProvider | AiWritingExternalProvider;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retirePrivateInput = useCallback(() => {
    generationRef.current += 1;
    setKey('');
    setConnections(null);
    setError('Writing connections are unavailable. Try again.');
    setBusy(null);
    mutationOwnerRef.current = null;
    callbacksRef.current.onDone?.();
  }, []);

  const loadConnections = useCallback(async () => {
    const owner = ++generationRef.current;
    setConnections(null);
    setError(null);
    try {
      const result = await getWritingConnections();
      if (!mountedRef.current || generationRef.current !== owner) return;
      if (result.status === 'failed') {
        setError(failureCopy(result.reason));
        return;
      }
      setConnections(result.state);
      setMode(result.state.mode);
      setExternalProvider(result.state.externalProvider);
      const initial = result.state.selected ?? 'openai';
      setProvider(initial);
      setShowKeyEntry(!result.state.providers[initial].configured);
    } catch {
      if (!mountedRef.current || generationRef.current !== owner) return;
      setError('Couldn’t access secure storage. Try again.');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadConnections();

    const subscription = AppState.addEventListener(
      'change',
      (next: AppStateStatus) => {
        if (next !== 'active') retirePrivateInput();
      },
    );
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      mutationOwnerRef.current = null;
      subscription.remove();
    };
  }, [loadConnections, retirePrivateInput]);

  const chooseMode = useCallback(
    (next: AiWritingMode) => {
      if (busy || mutationOwnerRef.current !== null) return;
      generationRef.current += 1;
      setMode(next);
      setKey('');
      setError(null);
      if (next === 'api') {
        setShowKeyEntry(!connections?.providers[provider].configured);
      }
    },
    [busy, connections, provider],
  );

  const chooseProvider = useCallback(
    (next: AiWritingProvider) => {
      if (busy || mutationOwnerRef.current !== null) return;
      generationRef.current += 1;
      setProvider(next);
      setKey('');
      setError(null);
      setShowKeyEntry(!connections?.providers[next].configured);
    },
    [busy, connections],
  );

  const runMutation = useCallback(
    async (
      mutation: Exclude<Mutation, 'external'>,
      target: AiWritingProvider,
    ) => {
      if (busy || mutationOwnerRef.current !== null) return;
      const trimmedKey = key.trim();
      if (mutation === 'save' && trimmedKey.length === 0) return;

      const owner = ++generationRef.current;
      mutationOwnerRef.current = owner;
      setBusy({ mutation, provider: target });
      setError(null);
      try {
        const result =
          mutation === 'save'
            ? await saveWritingConnection(target, trimmedKey)
            : mutation === 'select'
            ? await selectWritingProvider(target)
            : await removeWritingConnection(target);
        if (mutationOwnerRef.current === owner) mutationOwnerRef.current = null;
        if (!mountedRef.current || generationRef.current !== owner) return;
        setBusy(null);
        if (result.status === 'failed') {
          setError(failureCopy(result.reason));
          return;
        }

        setConnections(result.state);
        setMode('api');
        setExternalProvider(result.state.externalProvider);
        setKey('');
        const nextProvider = result.state.providers[target].configured
          ? target
          : result.state.selected ?? target;
        setProvider(nextProvider);
        setShowKeyEntry(!result.state.providers[nextProvider].configured);
        callbacksRef.current.onChanged?.();
        if (mutation !== 'remove') callbacksRef.current.onDone?.();
      } catch {
        if (mutationOwnerRef.current === owner) mutationOwnerRef.current = null;
        if (!mountedRef.current || generationRef.current !== owner) return;
        setBusy(null);
        setError('Couldn’t access secure storage. Try again.');
      }
    },
    [busy, key],
  );

  const chooseExternalProvider = useCallback(
    async (target: AiWritingExternalProvider) => {
      if (busy || mutationOwnerRef.current !== null) return;
      const owner = ++generationRef.current;
      mutationOwnerRef.current = owner;
      setBusy({ mutation: 'external', provider: target });
      setError(null);
      try {
        const result = await selectExternalWritingProvider(target);
        if (mutationOwnerRef.current === owner) mutationOwnerRef.current = null;
        if (!mountedRef.current || generationRef.current !== owner) return;
        setBusy(null);
        if (result.status === 'failed') {
          setError(failureCopy(result.reason));
          return;
        }
        setConnections(result.state);
        setMode('external');
        setExternalProvider(result.state.externalProvider);
        setKey('');
        callbacksRef.current.onChanged?.();
        callbacksRef.current.onDone?.();
      } catch {
        if (mutationOwnerRef.current === owner) mutationOwnerRef.current = null;
        if (!mountedRef.current || generationRef.current !== owner) return;
        setBusy(null);
        setError('Couldn’t save the writing preference. Try again.');
      }
    },
    [busy],
  );

  if (!connections && !error) {
    return (
      <View
        testID="writing-connection-loading"
        accessibilityLiveRegion="polite"
        accessibilityLabel="Loading writing connections"
        style={styles.loading}
      >
        <ActivityIndicator color={t.color.pine} />
        <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>
          Loading…
        </Text>
      </View>
    );
  }

  if (!connections) {
    return (
      <View testID="writing-connection" style={styles.container}>
        <Text
          accessibilityRole="header"
          style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
        >
          Writing assistant
        </Text>
        <InlineError
          message={error ?? 'Couldn’t access secure storage. Try again.'}
          testID="writing-connection-error"
          marginTop={0}
        />
        <OutlineButton
          size="compact"
          label="Retry"
          testID="writing-connection-retry"
          onPress={loadConnections}
        />
        {onDone && showDone ? (
          <View style={styles.doneRow}>
            <TextAction
              label="Done"
              testID="writing-connection-done"
              onPress={onDone}
            />
          </View>
        ) : null}
      </View>
    );
  }

  const selectedConfigured = connections.providers[provider].configured;
  const selectedLabel = AI_WRITING_PROVIDER_LABELS[provider];

  return (
    <View testID="writing-connection" style={styles.container}>
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        Writing assistant
      </Text>
      <View accessibilityRole="radiogroup" style={styles.modeGrid}>
        <Pressable
          testID="writing-mode-external"
          accessibilityRole="radio"
          accessibilityLabel="Use ChatGPT or Claude"
          accessibilityState={{
            selected: mode === 'external',
            disabled: !!busy,
          }}
          disabled={!!busy}
          onPress={() => chooseMode('external')}
          style={({ pressed }) => [
            styles.mode,
            {
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.button,
              borderColor:
                mode === 'external' ? t.color.pine : t.color.lineSoft,
              backgroundColor:
                mode === 'external'
                  ? t.color.pineWash
                  : pressed
                  ? t.color.paperInset
                  : t.color.paperSheet,
            },
          ]}
        >
          <Text style={[t.type.buttonCompact, { color: t.color.inkStrong }]}>
            Use ChatGPT or Claude
          </Text>
          <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
            Your app and account
          </Text>
        </Pressable>
        <Pressable
          testID="writing-mode-api"
          accessibilityRole="radio"
          accessibilityLabel="Use API key"
          accessibilityState={{ selected: mode === 'api', disabled: !!busy }}
          disabled={!!busy}
          onPress={() => chooseMode('api')}
          style={({ pressed }) => [
            styles.mode,
            {
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.button,
              borderColor: mode === 'api' ? t.color.pine : t.color.lineSoft,
              backgroundColor:
                mode === 'api'
                  ? t.color.pineWash
                  : pressed
                  ? t.color.paperInset
                  : t.color.paperSheet,
            },
          ]}
        >
          <Text style={[t.type.buttonCompact, { color: t.color.inkStrong }]}>
            Use API key
          </Text>
          <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
            Optional · provider charges may apply
          </Text>
        </Pressable>
      </View>

      {mode === 'external' ? (
        <View style={styles.section}>
          <Text
            style={[
              t.type.compactBody,
              styles.explainer,
              { color: t.color.inkBody },
            ]}
          >
            Tacendum copies a request only when you choose an action. You switch
            apps, use the account there, and paste the reply back for review.
            Tacendum does not make a paid API request.
          </Text>
          <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
            OPEN WITH
          </Text>
          <View accessibilityRole="radiogroup" style={styles.providerGrid}>
            {AI_WRITING_EXTERNAL_PROVIDERS.map(item => {
              const selected = externalProvider === item;
              const inUse =
                connections.mode === 'external' &&
                connections.externalProvider === item;
              const label = AI_WRITING_EXTERNAL_PROVIDER_LABELS[item];
              return (
                <Pressable
                  key={item}
                  testID={'writing-external-' + item}
                  accessibilityRole="radio"
                  accessibilityLabel={label + (inUse ? ', in use' : '')}
                  accessibilityState={{ selected, disabled: !!busy }}
                  disabled={!!busy}
                  onPress={() => void chooseExternalProvider(item)}
                  style={({ pressed }) => [
                    styles.provider,
                    {
                      minHeight: t.layout.touchTarget,
                      borderRadius: t.radius.button,
                      borderColor: selected
                        ? t.color.pine
                        : t.color.lineSoft,
                      backgroundColor: selected
                        ? t.color.pineWash
                        : pressed
                        ? t.color.paperInset
                        : t.color.paperSheet,
                    },
                  ]}
                >
                  <Text
                    style={[
                      t.type.buttonCompact,
                      { color: t.color.inkStrong },
                    ]}
                  >
                    {label}
                  </Text>
                  <Text
                    style={[t.type.timeStatus, { color: t.color.inkMuted }]}
                  >
                    {busy?.mutation === 'external' && busy.provider === item
                      ? 'Saving…'
                      : inUse
                      ? 'In use'
                      : 'Use this app'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : (
        <View style={styles.section}>
      <Text
        style={[
          t.type.compactBody,
          styles.explainer,
          { color: t.color.inkBody },
        ]}
      >
        Your draft goes directly to OpenAI or Claude from Tacendum. Your API key
        is stored securely on this device. API billing is separate from ChatGPT
        and Claude subscriptions.
      </Text>

      <View accessibilityRole="radiogroup" style={styles.providerGrid}>
        {AI_WRITING_PROVIDERS.map(item => {
          const configured = connections.providers[item].configured;
          const inUse =
            connections.mode === 'api' && connections.selected === item;
          const label = AI_WRITING_PROVIDER_LABELS[item];
          const selected = provider === item;
          return (
            <Pressable
              key={item}
              testID={`writing-provider-${item}`}
              accessibilityRole="radio"
              accessibilityLabel={`${label}, ${
                configured ? 'Saved' : 'Not saved'
              }${inUse ? ', in use' : ''}`}
              accessibilityState={{ selected, disabled: !!busy }}
              disabled={!!busy}
              onPress={() => chooseProvider(item)}
              style={({ pressed }) => [
                styles.provider,
                {
                  minHeight: t.layout.touchTarget,
                  borderRadius: t.radius.button,
                  borderColor: selected ? t.color.pine : t.color.lineSoft,
                  backgroundColor: selected
                    ? t.color.pineWash
                    : pressed
                    ? t.color.paperInset
                    : t.color.paperSheet,
                },
              ]}
            >
              <Text
                style={[t.type.buttonCompact, { color: t.color.inkStrong }]}
              >
                {label}
              </Text>
              <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                {configured ? 'Saved' : 'Not saved'}
                {inUse ? ' · In use' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {selectedConfigured && !showKeyEntry ? (
        <View style={styles.savedActions}>
          {connections.mode !== 'api' || connections.selected !== provider ? (
            <OutlineButton
              size="compact"
              label={`Use ${selectedLabel}`}
              testID={`writing-use-${provider}`}
              disabled={!!busy}
              onPress={() => void runMutation('select', provider)}
            />
          ) : null}
          <TextAction
            label="Replace key"
            testID="writing-replace-key"
            disabled={!!busy}
            onPress={() => {
              generationRef.current += 1;
              setKey('');
              setError(null);
              setShowKeyEntry(true);
            }}
          />
          <TextAction
            label={`Remove ${selectedLabel} key`}
            testID={`writing-remove-${provider}`}
            tone="danger"
            disabled={!!busy}
            onPress={() => void runMutation('remove', provider)}
          />
        </View>
      ) : (
        <View style={styles.keyArea}>
          <Text style={[t.type.utilityLabel, { color: t.color.inkMuted }]}>
            {selectedLabel.toUpperCase()} API KEY
          </Text>
          <TextInput
            testID="writing-key-input"
            value={key}
            onChangeText={next => {
              setKey(next);
              setError(null);
            }}
            placeholder="Paste API key"
            placeholderTextColor={t.color.inkMuted}
            keyboardAppearance={t.scheme}
            selectionColor={t.color.pine}
            accessibilityLabel={`${selectedLabel} API key`}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            importantForAutofill="no"
            editable={!busy}
            style={[
              styles.input,
              t.type.input,
              {
                minHeight: t.layout.buttonHeight,
                borderRadius: t.radius.button,
                borderColor: t.color.lineStrong,
                backgroundColor: t.color.paperSheet,
                color: t.color.inkStrong,
              },
            ]}
          />
          <PrimaryButton
            label={`Save ${selectedLabel} key`}
            busy={busy?.mutation === 'save' && busy.provider === provider}
            busyLabel="Saving key…"
            disabled={key.trim().length === 0 || !!busy}
            testID="writing-key-save"
            onPress={() => void runMutation('save', provider)}
          />
          {selectedConfigured ? (
            <TextAction
              label="Cancel replacement"
              disabled={!!busy}
              onPress={() => {
                generationRef.current += 1;
                setKey('');
                setError(null);
                setShowKeyEntry(false);
              }}
            />
          ) : null}
        </View>
      )}
        </View>
      )}

      {error ? (
        <InlineError message={error} testID="writing-connection-error" />
      ) : null}
      {onDone && showDone ? (
        <View style={styles.doneRow}>
          <TextAction
            label="Done"
            testID="writing-connection-done"
            onPress={onDone}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    minWidth: 0,
  },
  loading: {
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  modeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mode: {
    flexGrow: 1,
    flexBasis: 148,
    minWidth: 0,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    justifyContent: 'center',
  },
  section: {
    gap: 10,
  },
  explainer: {
    marginTop: -4,
  },
  providerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  provider: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 0,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  savedActions: {
    alignItems: 'flex-start',
    gap: 2,
  },
  keyArea: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  doneRow: {
    alignItems: 'flex-end',
  },
});
