/**
 * THE SYSTEM-BACK NET.
 *
 * Android has one global dismiss gesture and this app answered it in three
 * places. `BackHandler.addEventListener('hardwareBackPress', …)` lived in
 * `App.tsx` (the router, which pops the ROUTE), in `ChatThreadScreen.tsx`
 * and in `RegisterScreen.tsx` — and nowhere else. There is no `<Modal>`
 * anywhere in the tree either, so React Native's own back handling, which
 * only ever applies to a modal host, never applied. Every other overlay in
 * the app — every inline confirmation, every drawer, every sub-step of the
 * App Lock ceremony — was invisible to the back button, so the press that
 * dismisses a confirmation in every other Android app instead threw the
 * person off the screen the confirmation was about. Worst case: half way
 * through entering a new App Lock passcode, back lands on Profile with the
 * flow discarded.
 *
 * WHAT THIS FILE ASSERTS. Every file under `app/src/screens/` that declares
 * a state variable whose name matches
 *
 * /^(confirming|menu|flow|step|editing|sheet)/
 *
 * also registers a `hardwareBackPress` listener. That is deliberately blunt.
 * It cannot tell a good handler from a bad one — `back.overlays.android`
 * does that, screen by screen, by opening the overlay and firing the press.
 * What this file catches is the ELEVENTH screen: the one somebody adds in
 * six months by copying the tenth, with a `confirmingSomething` state and no
 * listener, on a night when nobody remembers this sweep happened. A per-file
 * behavioural test cannot catch that, because a test for a screen that does
 * not exist yet cannot exist yet. This one can.
 *
 * THE PREDICATE IS A NAMING CONVENTION, and that is its whole weakness: a
 * screen whose overlay state is called `showPanel` is not seen. It was
 * chosen by reading the ten screens that HAD such state and taking the
 * prefixes they already used, so it costs nothing to satisfy and catches the
 * copy — which is how the overlay state gets written in the first place.
 *
 * THE ONE LIVE SURFACE THAT WEAKNESS COSTS TODAY, recorded here rather than
 * left for someone to rediscover: `ProfileScreen`'s `qrOpen` (`:176`) is a
 * genuine dismissible panel with a Hide control of its own, and back walks
 * straight through it. It is outside the predicate and outside the plan's
 * enumeration, so this sweep did not ship it; it is owed to build 28,
 * together with the question of whether the predicate should grow a `qr`/
 * `show` prefix or the panel should be renamed into the convention.
 *
 * WHAT THIS FILE ASKS OF A FILE, IT ASKS ONCE. The check is per FILE, not
 * per component: a screen file that registers one listener satisfies it even
 * if some sibling component inside it holds overlay state of its own.
 * `PeerProfileScreen` is exactly that shape — `ReportSection`'s `step` and
 * `MachineSection`'s `confirming` are state the screen component cannot
 * read — and the answer there is NOT a second registration: each section
 * publishes a closer into a ref the screen owns, so one listener still
 * answers for the whole page in a stated order. The case below that pins
 * exactly one registration per screen is what keeps that decision from
 * quietly becoming two handlers racing for the same press, and
 * `back.overlays.android.test.tsx` is what proves the sections' questions
 * actually close.
 *
 * Why an AST walk and not a grep: a grep for `confirming` matches the word
 * in a comment, in a copy string, in a prop being passed down to a child;
 * and a grep for `BackHandler.addEventListener` matches the same words
 * inside a doc comment ABOUT the pattern, which is exactly the shape a
 * half-done sweep leaves behind. The walk reads declarations and calls.
 * (`inputs.contract.test.ts` is the idiom this file
 * follows, and `android.copy.divergences.test.ts` is the idiom before that.)
 *
 * Falsifiers, per CONTRIBUTING.md: the scan is split from the file reader,
 * so every planted case below goes through the very same parser and the very
 * same predicate the sweep runs over the real tree.
 */

// This file imports nothing, so the export makes it a module — otherwise its
// top-level consts share the global script scope with the other require()-
// style repo readers in this directory.
export {};

// The app's tsconfig types only `jest`, so node's modules are absent from
// the type environment though present at runtime — the same idiom
// inputs.contract.test.ts and android.copy.divergences.test.ts use.
const { readFileSync, readdirSync, statSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
const { join, basename } = require('path') as {
  join: (...parts: string[]) => string;
  basename: (path: string) => string;
};
const ts = require('typescript') as any;
declare const __dirname: string;

const APP_ROOT = join(__dirname, '..');
const SCREENS = join(APP_ROOT, 'src', 'screens');

/**
 * The prefixes an overlay's state is written with in this app, read off the
 * ten screens that already had one. Anchored: `confirmed` is an outcome, not
 * a question being asked, and `stepper` is a control.
 */
const OVERLAY_STATE = /^(confirming|menu|flow|step|editing|sheet)/;

/** The hooks that make a value STATE. A `useRef` overlay would not re-render
 * and so cannot be one; a plain array destructure is not one either. */
const STATE_HOOKS = new Set(['useState', 'useReducer']);

/**
 * The eight screens this cluster wired, and the two that were already wired
 * before it. Ten files carry overlay state; eight registrations were added.
 * The arithmetic is pinned here on purpose: if the
 * predicate ever silently stops matching a screen, the sweep below would
 * pass by finding nothing, and this list is what refuses that.
 */
const WIRED_BY_THIS_CLUSTER = [
  'AccountEmailScreen.tsx',
  'AccountPhoneScreen.tsx',
  'AccountUsernameScreen.tsx',
  'ChatListScreen.tsx',
  'GroupProfileScreen.tsx',
  'PeerProfileScreen.tsx',
  'ProfileScreen.tsx',
  'SettingsScreen.tsx',
] as const;

/** Screens that already answer Back presses: the thread
 * and Register's mid-flight refusal. */
const WIRED_ALREADY = ['ChatThreadScreen.tsx', 'RegisterScreen.tsx'] as const;

const ENUMERATED: string[] = [...WIRED_BY_THIS_CLUSTER, ...WIRED_ALREADY];

interface Scan {
  file: string;
  /** Every overlay-shaped state variable this file declares, with its line. */
  states: { name: string; line: number }[];
  /** Whether the file registers a `hardwareBackPress` listener. */
  registers: boolean;
  /** How many it registers. One per screen is the rule;
   * two would mean two handlers answering one press in whatever order the
   * components happened to mount in. */
  registrations: number;
}

/** The callee's own name: `useState` for both `useState` and `React.useState`. */
function calleeName(expr: any): string | null {
  if (ts.isIdentifier(expr)) return expr.text as string;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text as string;
  return null;
}

/**
 * The scan, split from the file reader so the falsifiers below feed PLANTED
 * source through the very same predicate the sweep uses.
 */
function scanSource(file: string, sourceText: string): Scan {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const states: { name: string; line: number }[] = [];
  let registrations = 0;
  const visit = (node: any): void => {
    // `const [confirming, setConfirming] = useState(false)` — the array
    // destructure of a state hook, first element only. The setter's name is
    // derived from the value's and says nothing extra.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer != null &&
      ts.isCallExpression(node.initializer)
    ) {
      const hook = calleeName(node.initializer.expression);
      const first = node.name.elements[0];
      if (
        hook !== null &&
        STATE_HOOKS.has(hook) &&
        first !== undefined &&
        ts.isBindingElement(first) &&
        ts.isIdentifier(first.name) &&
        OVERLAY_STATE.test(first.name.text as string)
      ) {
        states.push({
          name: first.name.text as string,
          line:
            ts.getLineAndCharacterOfPosition(source, first.getStart(source))
              .line + 1,
        });
      }
    }
    // `BackHandler.addEventListener('hardwareBackPress', …)`. Both halves
    // are read: a listener for some other event is not this one, and the
    // words inside a string or a comment are not a call at all.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text as string) === 'addEventListener' &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text as string) === 'BackHandler'
    ) {
      const first = node.arguments[0];
      if (
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        (first.text as string) === 'hardwareBackPress'
      ) {
        registrations += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { file, states, registers: registrations > 0, registrations };
}

/** Every screen source file: `app/src/screens`, recursively. */
function screenFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(SCREENS);
  return out.sort();
}

const ALL: Scan[] = screenFiles().map(file =>
  scanSource(file, readFileSync(file, 'utf8')),
);

/** The screens that hold an overlay, by file name — what the sweep governs. */
const HOLDS_OVERLAY: Scan[] = ALL.filter(s => s.states.length > 0);
const nameOf = (s: Scan): string => basename(s.file);

describe('every screen with an overlay answers the Android back button', () => {
  it('the scanner really scans (it finds the ten known screens, not nothing)', () => {
    // A floor plus the enumeration, never an equality: an eleventh screen
    // with overlay state must not have to edit this test — it must only
    // carry the listener, which the next case is what demands.
    const found = HOLDS_OVERLAY.map(nameOf);
    for (const file of ENUMERATED) expect(found).toContain(file);
    expect(found.length).toBeGreaterThanOrEqual(ENUMERATED.length);
  });

  it('the arithmetic in the plan is the arithmetic here: ten hold one, eight were added', () => {
    // Ten screens hold overlay state; two answered the
    // press already; so this cluster owed exactly eight registrations. If
    // the predicate drifts, this is the line that says so.
    expect(ENUMERATED).toHaveLength(10);
    expect(ENUMERATED.length - WIRED_ALREADY.length).toBe(8);
    expect(WIRED_BY_THIS_CLUSTER).toHaveLength(8);
  });

  it('each of the ten answers the button in exactly one place', () => {
    // ONE listener per screen. Two would put the order in
    // which a screen retires its overlays at the mercy of which component
    // mounted last — React runs a child's effects before its parent's, and RN
    // asks the newest subscriber FIRST, so a section that registered its own
    // would be asked after the screen had already yielded. Where a sibling
    // component owns overlay state (`PeerProfileScreen`), it publishes a
    // closer into a ref the screen's single handler calls, and this line is
    // what keeps that from being rewritten as a second registration.
    const two = ALL.filter(
      s => ENUMERATED.includes(nameOf(s)) && s.registrations !== 1,
    ).map(s => `app/src/screens/${nameOf(s)} registers ${s.registrations}`);
    expect(two).toEqual([]);
  });

  it('every screen holding a dismissible overlay registers hardwareBackPress', () => {
    const short = HOLDS_OVERLAY.filter(s => !s.registers).map(
      s =>
        `app/src/screens/${nameOf(s)} holds ${s.states
          .map(v => `${v.name}:${v.line}`)
          .join(', ')} and registers no hardwareBackPress listener`,
    );
    expect(short).toEqual([]);
  });
});

describe('the net can actually fail', () => {
  it('a screen with an overlay state and no listener is caught', () => {
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [confirmingUnlink, setConfirmingUnlink] = useState(false);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['confirmingUnlink']);
    expect(planted.registers).toBe(false);
  });

  it('a comment naming the pattern does not count as carrying it', () => {
    // The reason this is a parse and not a grep. Comments are trivia and are
    // never visited, so a docblock explaining the sweep — which every one of
    // these eight screens now has — cannot satisfy the sweep.
    const planted = scanSource(
      'Planted.tsx',
      [
        '// BackHandler.addEventListener(\'hardwareBackPress\', …) belongs here.',
        'export function PlantedScreen() {',
        '  const [menu, setMenu] = useState(null);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['menu']);
    expect(planted.registers).toBe(false);
  });

  it('the words inside a string literal are not a registration either', () => {
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [flow, setFlow] = useState({ step: \'menu\' });',
        "  const note = \"BackHandler.addEventListener('hardwareBackPress'\";",
        '  return <View>{note}</View>;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['flow']);
    expect(planted.registers).toBe(false);
  });

  it('a listener for some other event is not this listener', () => {
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [editing, setEditing] = useState(false);',
        "  BackHandler.addEventListener('hardwareBackPressElsewhere', () => false);",
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['editing']);
    expect(planted.registers).toBe(false);
  });

  it('a real registration satisfies it, including through a subscription variable', () => {
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [sheet, setSheet] = useState(false);',
        '  useEffect(() => {',
        '    const sub = BackHandler.addEventListener(',
        "      'hardwareBackPress',",
        '      () => sheetRef.current,',
        '    );',
        '    return () => sub.remove();',
        '  }, []);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['sheet']);
    expect(planted.registers).toBe(true);
  });

  it('a second registration in one file is seen as a second registration', () => {
    // The falsifier for the one-listener case above: the count is a count,
    // not a boolean wearing a number's clothes.
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [confirming, setConfirming] = useState(false);',
        '  useEffect(() => {',
        "    const a = BackHandler.addEventListener('hardwareBackPress', () => false);",
        '    return () => a.remove();',
        '  }, []);',
        '  return <Section />;',
        '}',
        'function Section() {',
        '  useEffect(() => {',
        "    const b = BackHandler.addEventListener('hardwareBackPress', () => true);",
        '    return () => b.remove();',
        '  }, []);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.registers).toBe(true);
    expect(planted.registrations).toBe(2);
  });

  it('the predicate is anchored: `confirmed` is an outcome, not an open question', () => {
    // And it is a PREFIX, not a whole word — `stepperWidth` would match, and
    // that is the deliberate trade. The prefix is what makes a copied screen
    // satisfy the sweep by accident; a screen made to carry a listener it
    // does not need costs one dead branch, a screen missing one costs the
    // person the page they were reading.
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [confirmed, setConfirmed] = useState(false);',
        '  const [edited, setEdited] = useState(false);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states).toEqual([]);
  });

  it('a plain array destructure is not state (only useState/useReducer are)', () => {
    // Without this the sweep would demand a back listener from any screen
    // that happened to destructure a tuple into a variable called `step`.
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [step, total] = splitProgress(value);',
        '  const [menu] = useMemo(() => buildMenu(), []);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states).toEqual([]);
  });

  it('useReducer counts, and React.useState counts', () => {
    const planted = scanSource(
      'Planted.tsx',
      [
        'export function PlantedScreen() {',
        '  const [flow, dispatch] = useReducer(flowReducer, START);',
        '  const [editing, setEditing] = React.useState(false);',
        '  return <View />;',
        '}',
      ].join('\n'),
    );
    expect(planted.states.map(s => s.name)).toEqual(['flow', 'editing']);
  });
});
