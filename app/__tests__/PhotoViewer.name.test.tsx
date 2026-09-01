/**
 * The photo viewer's sender slot names the AUTHENTICATED AUTHOR — never the
 * room. The route's peerId is the THREAD id, which in a room is the room's
 * ULID; the first version of this screen resolved the name from it, so a
 * photo Cara sent into "Family" was captioned with my rename of the ROOM, or
 * with the room's id fragment — the exact violation ("no screen renders a
 * room's id, and no author label is derived from anything but authorId").
 */

jest.mock('../src/db', () => ({
  getAttachment: jest.fn(),
  getMessage: jest.fn(),
  getChat: jest.fn(),
}));
jest.mock('../src/messaging', () => ({
  messaging: { subscribe: jest.fn(() => () => undefined) },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { PhotoViewerScreen } from '../src/screens/PhotoViewerScreen';

const getAttachment = db.getAttachment as jest.MockedFunction<typeof db.getAttachment>;
const getMessage = db.getMessage as jest.MockedFunction<typeof db.getMessage>;
const getChat = db.getChat as jest.MockedFunction<typeof db.getChat>;

const ROOM = '01ROOMROOMROOMROOMROOMROOM';
const AUTHOR = '01CARACARACARACARACARACARA';
const PEER = '01PEERPEERPEERPEERPEERPEER';
const MSG = '01MSGMSGMSGMSGMSGMSGMSGMSG';
const T0 = new Date('2026-07-25T12:00:00').getTime();

function messageRow(over: Partial<{ peerId: string; authorId: string | null }>) {
  return {
    msgId: MSG,
    peerId: over.peerId ?? PEER,
    direction: 'in',
    body: '',
    ts: T0,
    status: 'read',
    authorId: over.authorId ?? null,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  getAttachment.mockResolvedValue({
    msgId: MSG,
    direction: 'in',
    state: 'ready',
    dataB64: 'QUJD',
    w: 4,
    h: 3,
  } as never);
  getChat.mockResolvedValue(null);
});

async function renderViewer(peerId: string, selfId?: string): Promise<string> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PhotoViewerScreen
        msgId={MSG}
        direction="in"
        peerId={peerId}
        selfId={selfId}
        onClose={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  const rendered = JSON.stringify(tree.toJSON());
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
  return rendered;
}

it('a room photo is captioned with its AUTHOR, resolved from the author’s chat row', async () => {
  getMessage.mockResolvedValue(messageRow({ peerId: ROOM, authorId: AUTHOR }));
  getChat.mockResolvedValue({ peerId: AUTHOR, displayName: 'Cara', localName: null } as never);

  const rendered = await renderViewer(ROOM);

  expect(getChat).toHaveBeenCalledWith(AUTHOR);
  expect(getChat).not.toHaveBeenCalledWith(ROOM);
  expect(rendered).toContain('Cara');
});

it('an unnamed author degrades to THEIR id fragment — never the room’s', async () => {
  getMessage.mockResolvedValue(messageRow({ peerId: ROOM, authorId: AUTHOR }));

  const rendered = await renderViewer(ROOM);

  expect(rendered).toContain(AUTHOR.slice(-8));
  expect(rendered).not.toContain(ROOM.slice(-8));
});

it('a peer self-named "You" is refused the sender slot', async () => {
  // 'You' in this bar means MY photo (direction out); a profile card must
  // not be able to occupy it over an incoming one.
  getMessage.mockResolvedValue(messageRow({ peerId: ROOM, authorId: AUTHOR }));
  getChat.mockResolvedValue({ peerId: AUTHOR, displayName: 'You', localName: null } as never);

  const rendered = await renderViewer(ROOM);

  expect(rendered).toContain(AUTHOR.slice(-8));
  expect(rendered).not.toContain('"You"');
});

it('a history-shared copy of MY OWN photo says "You", not my id fragment', async () => {
  // History sharing relays my room message back as direction 'in' with
  // authorId = me; the thread's nameFor labels that row "You" and this bar
  // must agree — my own id has no chat row, so without the selfId check the
  // caption degrades to my ULID tail.
  const SELF = '01SELFSELFSELFSELFSELFSELF';
  getMessage.mockResolvedValue(messageRow({ peerId: ROOM, authorId: SELF }));

  const rendered = await renderViewer(ROOM, SELF);

  expect(rendered).toContain('You');
  expect(rendered).not.toContain(SELF.slice(-8));
});

it('no name is painted from the THREAD id while the message row is loading', async () => {
  // The route's peerId is the thread — in a room, the room's ULID. A frame
  // rendered before getMessage resolves must say "Photo", never the room's
  // fragment, and never a name fetched for the wrong id.
  getMessage.mockReturnValue(new Promise(() => undefined) as never);

  const rendered = await renderViewer(ROOM);

  expect(rendered).not.toContain(ROOM.slice(-8));
  expect(rendered).toContain('Photo');
});

it('a 1:1 photo still names the peer, my label outranking their card', async () => {
  getMessage.mockResolvedValue(messageRow({ peerId: PEER, authorId: null }));
  getChat.mockResolvedValue({ peerId: PEER, displayName: 'Helen R.', localName: 'Mum' } as never);

  const rendered = await renderViewer(PEER);

  expect(getChat).toHaveBeenCalledWith(PEER);
  expect(rendered).toContain('Mum');
  expect(rendered).not.toContain('Helen R.');
});
