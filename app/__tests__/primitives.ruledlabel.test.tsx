/**
 * The two shared pieces this release adds to `src/ui/` for the screens to
 * take up: RuledLabel's `heading` prop, and the `useTransientNotice` hook.
 *
 * RuledLabel draws two different things: a Settings section label, which a
 * VoiceOver user wants to jump between with the Headings rotor, and the
 * thread's date dividers, where a heading per day would flood that same rotor.
 * So the role is opt-in, never default, and each screen owner passes it. This
 * cluster ships the prop; the assertion that it is *absent* by default is the
 * half that protects the thread.
 *
 * These cases assert reachability, not spelling. A role on a View that is not
 * an accessibility element satisfies "the prop threads through" while being
 * inert to both VoiceOver and TalkBack, which is exactly the no-op this file
 * failed to catch the first time it was written.
 *
 * The hook's cases live in this file rather than one of their own because
 * `useTransientNotice.test.tsx` is outside this cluster's owned paths and a
 * second agent is working the same checkout — the shape is the same either
 * way: a self-clearing message, cancelled on unmount and on a re-show.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import { RuledLabel } from '../src/ui/primitives';
import { useTransientNotice } from '../src/ui/useTransientNotice';

function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  return tree;
}

/** The wrapping row — the first host node RuledLabel renders. */
function row(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(n => typeof n.type === 'string')[0]!;
}

describe('RuledLabel heading', () => {
  test('heading makes the row the section’s one reachable heading', () => {
    const tree = render(<RuledLabel label="APP LOCK" heading />);

    // The row is the section's single accessibility ELEMENT, not merely the
    // node the role is spelled on. `accessible` is what makes a View
    // enumerable at all: RN 0.86's View never derives it from
    // accessibilityRole (Libraries/Components/View/View.js maps aria-* and
    // nothing else), so a header trait on a bare View is a stop VoiceOver
    // never offers and a node TalkBack never focuses. The thread's unread
    // divider is the same shape — an accessible View around a RuledLabel.
    expect(row(tree).props.accessible).toBe(true);
    expect(row(tree).props.accessibilityRole).toBe('header');

    // One stop, and it carries the words. RN composes an accessible
    // container's label from the Text inside it, so the rotor announces
    // "APP LOCK"; a second element (or a second role) would give the rotor
    // two stops for one section.
    // Host nodes only: a prop on a composite appears again on the host it
    // renders, so an unfiltered findAll counts one row twice.
    expect(
      tree.root.findAll(
        n => typeof n.type === 'string' && n.props.accessibilityRole === 'header',
      ).length,
    ).toBe(1);
    expect(
      tree.root.findAll(n => typeof n.type === 'string' && n.props.accessible)
        .length,
    ).toBe(1);
    expect(tree.root.findByType(Text).props.children).toBe('APP LOCK');

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('without the prop the row is neither a heading nor an element', () => {
    const tree = render(<RuledLabel label="APP LOCK" />);

    expect(row(tree).props.accessibilityRole).toBeUndefined();
    // Not an element either: a ruled label that is not a section heading must
    // leave its Text as the thing a screen reader reaches, exactly as it does
    // today on eight screens.
    expect(row(tree).props.accessible).toBeUndefined();

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a date divider stays role-less, which is the regression that would hurt', () => {
    // The thread's own call shape (ChatThreadScreen's dividers): a timeStatus
    // role and a row floor, no heading. The unread divider and the round
    // header carry their own explicit header role; a second heading per day
    // would make the rotor useless in a long conversation.
    const tree = render(
      <RuledLabel label="Yesterday" role="timeStatus" minHeight={28} />,
    );

    expect(row(tree).props.accessibilityRole).toBeUndefined();
    // And the divider row is not swallowed into one element: the thread wraps
    // its own dividers in an accessible View with a composed label, and a
    // nested element here would take that label's place.
    expect(row(tree).props.accessible).toBeUndefined();

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('heading is orthogonal to the row floor and the type role', () => {
    const tree = render(
      <RuledLabel label="Yesterday" role="timeStatus" minHeight={28} heading />,
    );

    // Falsifier for the two tests above: pass the prop on the divider's own
    // shape and both halves appear. If they did not, "absent by default" would
    // be asserting about a prop that does nothing.
    expect(row(tree).props.accessibilityRole).toBe('header');
    expect(row(tree).props.accessible).toBe(true);

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

/** A host for the hook: renders what it holds, and exposes it to the test. */
function NoticeHost({
  ms,
  onReady,
}: {
  ms?: number;
  onReady: (api: ReturnType<typeof useTransientNotice>) => void;
}) {
  const api = useTransientNotice(ms);
  onReady(api);
  return <Text>{api.notice ?? 'none'}</Text>;
}

describe('useTransientNotice', () => {
  let api!: ReturnType<typeof useTransientNotice>;

  function mount(ms?: number) {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <NoticeHost
          ms={ms}
          onReady={next => {
            api = next;
          }}
        />,
      );
    });
    return tree;
  }

  function shown(tree: ReactTestRenderer.ReactTestRenderer) {
    return tree.root.findAll(n => typeof n.type === 'string')[0]!.props
      .children;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a message says its piece and goes', () => {
    const tree = mount();

    ReactTestRenderer.act(() => {
      api.show('App Lock is on.');
    });
    expect(shown(tree)).toBe('App Lock is on.');
    expect(api.seq).toBe(1);

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(2999);
    });
    // Falsifier for the clock: a hook that cleared on the next tick, or never,
    // would fail one of these two assertions.
    expect(shown(tree)).toBe('App Lock is on.');

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(shown(tree)).toBe('none');

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('saying the same thing again re-announces it and restarts the clock', () => {
    const tree = mount();

    ReactTestRenderer.act(() => {
      api.show('Code changed.');
    });
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(2500);
    });
    ReactTestRenderer.act(() => {
      api.show('Code changed.');
    });

    // seq is what InlineNotice re-announces on; the string alone is unchanged,
    // so without the bump the second save is silent to VoiceOver.
    expect(api.seq).toBe(2);

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(2999);
    });
    // The first show's timer would have fired 500 ms ago and taken the second
    // message with it.
    expect(shown(tree)).toBe('Code changed.');

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(shown(tree)).toBe('none');

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('clear takes it away now', () => {
    const tree = mount();

    ReactTestRenderer.act(() => {
      api.show('Decoy conversations rebuilt.');
    });
    ReactTestRenderer.act(() => {
      api.clear();
    });

    expect(shown(tree)).toBe('none');
    expect(jest.getTimerCount()).toBe(0);

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('unmounting cancels the timer', () => {
    const tree = mount();

    ReactTestRenderer.act(() => {
      api.show('App Lock is off.');
    });
    expect(jest.getTimerCount()).toBe(1);

    ReactTestRenderer.act(() => {
      tree.unmount();
    });

    // A timer that outlives the tree sets state on nothing — and in this suite
    // it keeps the test alive after it.
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a caller with a reason sets its own duration', () => {
    const tree = mount(500);

    ReactTestRenderer.act(() => {
      api.show('Saved.');
    });
    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(shown(tree)).toBe('none');

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
