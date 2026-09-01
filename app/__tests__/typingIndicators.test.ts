import {
  loadTypingIndicators,
  resetTypingIndicatorsForDuress,
  setTypingIndicators,
  typingIndicatorsEnabled,
} from '../src/typingIndicators';

const cryptoMock = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  getSecret: jest.Mock;
};

beforeEach(() => {
  cryptoMock.__keychain.clear();
  resetTypingIndicatorsForDuress(); // back to the default between tests
});

describe('typing indicators preference', () => {
  test('defaults ON when nothing is stored', async () => {
    await loadTypingIndicators();
    expect(typingIndicatorsEnabled()).toBe(true);
  });

  test('persists Off and survives a relaunch', async () => {
    await setTypingIndicators(false);
    expect(cryptoMock.__keychain.get('tacendum.typingIndicators')).toBe('0');

    // The process ends; the module's in-memory value goes with it.
    resetTypingIndicatorsForDuress();
    expect(typingIndicatorsEnabled()).toBe(true);
    await loadTypingIndicators();
    expect(typingIndicatorsEnabled()).toBe(false);
  });

  test('persists On as "1"', async () => {
    await setTypingIndicators(true);
    expect(cryptoMock.__keychain.get('tacendum.typingIndicators')).toBe('1');
  });

  test('a failed Keychain read fails to the DEFAULT, not to off', async () => {
    cryptoMock.getSecret.mockRejectedValueOnce(new Error('keychain hiccup'));
    await setTypingIndicators(false); // in-memory false before the failed load
    await loadTypingIndicators();
    expect(typingIndicatorsEnabled()).toBe(true);
  });

  test('duress shows the default without touching the persisted choice', async () => {
    await setTypingIndicators(false);
    resetTypingIndicatorsForDuress();
    expect(typingIndicatorsEnabled()).toBe(true);
    expect(cryptoMock.__keychain.get('tacendum.typingIndicators')).toBe('0');
    await loadTypingIndicators(); // the real unlock re-read
    expect(typingIndicatorsEnabled()).toBe(false);
  });
});
