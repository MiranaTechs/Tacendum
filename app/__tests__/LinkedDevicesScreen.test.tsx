/**
 * Linked devices:
 *
 *  - the roster row's accessibility label said "Device K3MQ,
 *    phone" for the user's OWN device (the visible row already says "This
 *    device") and used the raw class token instead of the one slot-word
 *    chokepoint (`LINKING_COPY.slotLabel`) every visible rendering goes
 *    through.
 *  - the recovery notices carry the device CLASS only
 *    (linking.ts) — never which identifier class proved the code — so their
 *    sentences must not claim the recovery used "your account's email". */
import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import * as db from '../src/db';
import * as linking from '../src/linking';
import { LINKING_COPY } from '../src/linkingCopy';
import { shortId } from '../src/person';
import { LinkedDevicesScreen } from '../src/screens/LinkedDevicesScreen';

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

const SELF = '01HQSELF000000000000000000';
const OTHER = '01HQ0THER00000000000000000';
const NOW_MS = 1_756_000_000_000;
const profile: db.ProfileRow = {
  userId: SELF,
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <LinkedDevicesScreen profile={profile} onBack={jest.fn()} onLinkNew={jest.fn()} />,
    );
  });
  return tree;
}

/** The row's Pressable — the node that carries the label AND the press. */
function row(tree: ReactTestRenderer.ReactTestRenderer, userId: string) {
  return tree.root
    .findAllByProps({ testID: `linked-device-${userId}` })
    .find(n => n.props.onPress !== undefined)!;
}

/** Every string inside the node carrying `testID`. */
const textOf = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): string =>
  tree.root
    .findByProps({ testID })
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');

beforeEach(() => {
  jest.spyOn(db, 'listLinkedDevices').mockResolvedValue([
    { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    { userId: OTHER, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
  ]);
  jest.spyOn(db, 'loadRecoveryNotice').mockResolvedValue(null);
  jest.spyOn(linking, 'reconcilePendingLink').mockResolvedValue(undefined as never);
  jest.spyOn(linking, 'redrivePendingMutations').mockResolvedValue(undefined as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the roster row is announced the way it is shown', () => {
  it('the own device says "This device" and the slot word; another device its short id and slot', async () => {
    const tree = await render();
    expect(row(tree, SELF).props.accessibilityLabel).toBe(
      `This device, ${LINKING_COPY.slotLabel('phone')}`,
    );
    expect(row(tree, OTHER).props.accessibilityLabel).toBe(
      `Device ${shortId(OTHER)}, ${LINKING_COPY.slotLabel('tablet')}`,
    );
    tree.unmount();
  });
});

describe('the recovery notices never name an identifier class they do not know', () => {
  it('the deck sentences are class-neutral', () => {
    expect(ACCOUNTS_COPY.noticeRequested('tablet', 'Friday')).not.toMatch(/email/i);
    expect(ACCOUNTS_COPY.noticeRequested('tablet', 'Friday')).toContain('tablet');
    expect(ACCOUNTS_COPY.noticeRequested('tablet', 'Friday')).toContain('Friday');
    expect(ACCOUNTS_COPY.noticeCompleted('tablet')).not.toMatch(/email/i);
    expect(ACCOUNTS_COPY.noticeCompleted('tablet')).toContain('tablet');
  });

  it('a requested notice renders with the slot and the deadline, and no identifier class', async () => {
    jest.spyOn(db, 'loadRecoveryNotice').mockResolvedValue({
      kind: 'requested',
      groupId: '01HQGGGG0000000000000000G0',
      class: 'tablet',
      completesAt: Math.floor(NOW_MS / 1000) + 72 * 3600,
      receivedAt: NOW_MS,
    });
    const tree = await render();
    const banner = textOf(tree, 'recovery-banner');
    expect(banner).toContain(LINKING_COPY.slotLabel('tablet'));
    expect(banner).not.toMatch(/email/i);
    tree.unmount();
  });

  it('a completed notice renders the same way', async () => {
    jest.spyOn(db, 'loadRecoveryNotice').mockResolvedValue({
      kind: 'completed',
      groupId: '01HQGGGG0000000000000000G0',
      class: 'phone',
      completesAt: null,
      receivedAt: NOW_MS,
    });
    const tree = await render();
    const line = textOf(tree, 'recovery-completed');
    expect(line).toContain(LINKING_COPY.slotLabel('phone'));
    expect(line).not.toMatch(/email/i);
    tree.unmount();
  });
});
