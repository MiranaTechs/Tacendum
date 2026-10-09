/**
 * THE INPUT-THEMING NET.
 *
 * Two half-applied patterns, finished and then fenced.
 *
 * 1. `placeholderTextColor` was on every `<TextInput` in the app; its two
 * siblings were on one of them. A field with no `keyboardAppearance`
 * raises the light iOS keyboard — a white slab over a near-black app —
 * and a field with no `selectionColor` draws the system-blue caret, a hue
 * that exists in neither palette. The three props are one pattern and
 * this file asserts them together.
 * 2. `<Switch` with no `trackColor` paints iOS system green (#34C759), again
 * a hue in neither palette. `trackColor`, `thumbColor` and
 * `ios_backgroundColor` are that control's three.
 *
 * AND THE VALUES, for the switch. A prop NAME is all the field sweep needs —
 * `selectionColor` is one colour and either it is passed or it is not. A
 * switch is different: its two track states are the whole state indicator, so
 * `trackColor` can be present, well-formed and still paint a control whose ON
 * and OFF read as the same colour. (They did, for one commit: `pineWash` was
 * then a 10% tint, it composites over the sheet behind it, and the pair measured
 * 1.05:1 in the light palette — with ON the LIGHTER of the two, inverting
 * `filled = on`. WCAG 2.1 SC 1.4.11 asks 3:1 of the part of a control that
 * identifies its state.) So this file also reads the two track values and
 * refuses a wash, a repeat, and a knob painted the colour of the track it
 * sits on. It does not compute contrast — it forbids the shapes that lose it.
 *
 * WHAT THIS TEST DOES NOT CLAIM. `keyboardAppearance` is an iOS-only prop.
 * On Android a dark Tacendum over a light system theme still raises a light
 * keyboard, and React Native core has no lever for it — the platform decides.
 * Setting the prop there is INERT, not wrong, and a green run of this file is
 * not evidence about any Android keyboard. It is evidence that no field was
 * left behind on iOS, which is the regression this net exists to catch: the
 * twentieth field, added by someone who copied the nineteenth.
 *
 * Why an AST walk and not a grep: a grep counts the prop names in a file, not
 * the elements carrying them, so two props on ONE composer read as coverage
 * for a screen with three fields — which is exactly how this pattern came to
 * be half-applied. The walk reads elements, matches props to the element that
 * owns them, and names the file and line of anything short. The TypeScript
 * parser is already in the devDependency set (the D22 drift net,
 * `android.copy.divergences.test.ts`, is the idiom this file follows).
 *
 * Falsifiers, per CONTRIBUTING.md: the scan is split from the file reader so
 * planted source goes through the very same predicate, and nine cases below
 * prove it rejects what it must.
 */

// This file imports nothing, so the export makes it a module — otherwise its
// top-level consts share the global script scope with the other require()-
// style repo readers in this directory.
export {};

// The app's tsconfig types only `jest`, so node's modules are absent from the
// type environment though present at runtime — the same idiom
// android.copy.divergences.test.ts and version.test.ts use to read repo files.
const { readFileSync, readdirSync, statSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
const { join } = require('path') as { join: (...parts: string[]) => string };
const ts = require('typescript') as any;
declare const __dirname: string;

const APP_ROOT = join(__dirname, '..');

/**
 * The contract, per element name. Nothing here is decoration: each prop is a
 * colour the app already owns being applied to a surface the platform would
 * otherwise paint from its own palette.
 */
const REQUIRED: { readonly [tag: string]: readonly string[] } = {
  TextInput: ['keyboardAppearance', 'selectionColor', 'placeholderTextColor'],
  Switch: ['trackColor', 'thumbColor', 'ios_backgroundColor'],
};

/**
 * The floors the sweep is measured against, so a scanner that silently stops
 * finding elements cannot pass by finding none. Measured at b27's branch tip:
 * 20 `<TextInput` (18 screen/section fields, the thread composer, the find
 * field) and 3 `<Switch` (the unlink toggles on the email, phone and username
 * account screens). A floor, not an equality — a new field must not have to
 * edit this test, it must only carry the props.
 */
const FLOOR = { TextInput: 20, Switch: 3 } as const;

/**
 * The third element this file walks. `RuledLabel` is not a themed control —
 * it is the one component that draws BOTH a section label a VoiceOver user
 * wants to jump between and the thread's date dividers, where a heading per
 * day would flood the rotor the prop exists to make useful. So the role is
 * opt-in, each screen owner passes it, and the cases below pin who did and
 * who deliberately did not.
 */
const RULED = 'RuledLabel';

/** Every production source file: app/src recursively, plus App.tsx. */
function productionFiles(): string[] {
  const out: string[] = [join(APP_ROOT, 'App.tsx')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(APP_ROOT, 'src'));
  return out;
}

interface Element {
  file: string;
  /** The JSX tag's own name — the last identifier, so `Animated.TextInput`
   * counts as a TextInput and must carry the same props. */
  tag: string;
  line: number;
  /** The named attributes on this element, in source order. An attribute
   * written `={false}`, `={undefined}` or `={null}` is NOT recorded — a prop
   * explicitly set to nothing is not a prop that was passed, and a net that
   * counted it would wave through `keyboardAppearance={undefined}`, which is
   * exactly what a hurried copy of a conditional field looks like. */
  props: string[];
  /** Each recorded attribute's initializer as source text (`''` for the
   * shorthand form), plus one entry per property of an object-literal
   * initializer, keyed `trackColor.true`. How this file reads a VALUE. */
  exprs: { readonly [name: string]: string };
  /** True when the element carries a `{...spread}`, which could supply a
   * required prop from somewhere this walk cannot see. */
  spread: boolean;
  /** The source text of the `label` prop's expression, for the elements that
   * take one — how a RuledLabel is named here without pinning a line number
   * that every edit above it moves. */
  labelExpr: string | null;
}

/** The tag's own name: `TextInput` for both `<TextInput>` and
 * `<Animated.TextInput>`, `null` for anything not an identifier chain. */
function tagNameOf(tagName: any): string | null {
  if (ts.isIdentifier(tagName)) return tagName.text as string;
  if (ts.isPropertyAccessExpression(tagName))
    return tagName.name.text as string;
  return null;
}

/**
 * The source text of an attribute's initializer: `t.color.pine` for
 * `selectionColor={t.color.pine}`, `"Verification code"` for a string
 * literal, `''` for the shorthand form.
 */
function initializerText(init: any, sourceText: string): string {
  if (init == null) return '';
  return (
    ts.isJsxExpression(init) && init.expression != null
      ? sourceText.slice(init.expression.pos, init.expression.end)
      : sourceText.slice(init.pos, init.end)
  ).trim();
}

/**
 * True when an attribute is written but explicitly set to nothing —
 * `heading={false}`, `selectionColor={undefined}`, `thumbColor={null}`. The
 * prop is present in the source and absent at runtime, so the walk counts it
 * absent. A conditional (`dark ? 'dark': undefined`) is NOT this: the walk
 * cannot evaluate it and does not pretend to.
 */
function isFalsifiedInitializer(init: any): boolean {
  if (init == null) return false; // the shorthand form: `heading`
  if (!ts.isJsxExpression(init) || init.expression == null) return false;
  const expr = init.expression;
  return (
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && (expr.text as string) === 'undefined')
  );
}

/**
 * Every JSX element in a source text whose tag name is one this contract
 * governs, with the props it actually carries.
 *
 * Split from the file reader so the falsifiers below can feed PLANTED source
 * through the very same parser and the very same predicate the sweep uses.
 */
function elementsInSource(file: string, sourceText: string): Element[] {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Element[] = [];
  const visit = (node: any): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = tagNameOf(node.tagName);
      if (
        tag !== null &&
        (Object.prototype.hasOwnProperty.call(REQUIRED, tag) || tag === RULED)
      ) {
        const props: string[] = [];
        const exprs: { [name: string]: string } = {};
        let spread = false;
        let labelExpr: string | null = null;
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)) {
            const name = attr.name.text as string;
            const init = attr.initializer;
            if (isFalsifiedInitializer(init)) continue;
            props.push(name);
            exprs[name] = initializerText(init, sourceText);
            // `trackColor={{ false: …, true: … }}` — the two states are two
            // values, so they are recorded as two, keyed `trackColor.true`.
            if (
              init != null &&
              ts.isJsxExpression(init) &&
              init.expression != null &&
              ts.isObjectLiteralExpression(init.expression)
            ) {
              for (const prop of init.expression.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                const key = sourceText
                  .slice(prop.name.pos, prop.name.end)
                  .trim();
                exprs[`${name}.${key}`] = sourceText
                  .slice(prop.initializer.pos, prop.initializer.end)
                  .trim();
              }
            }
            if (name === 'label' && init != null) {
              labelExpr = initializerText(init, sourceText);
            }
          } else {
            spread = true;
          }
        }
        found.push({
          file,
          tag,
          line:
            ts.getLineAndCharacterOfPosition(source, node.getStart(source))
              .line + 1,
          props,
          exprs,
          spread,
          labelExpr,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function elementsIn(file: string): Element[] {
  return elementsInSource(file, readFileSync(file, 'utf8'));
}

/**
 * The predicate, stated once: the props this element is missing. A spread is
 * NOT an excuse — an object assembled elsewhere that happens to carry
 * `selectionColor` today is not a contract, and the two fields that do spread
 * a shared constant spread keyboard hygiene, not colour.
 */
function missingOn(el: Element): string[] {
  const need = REQUIRED[el.tag] ?? [];
  return need.filter(p => !el.props.includes(p));
}

/**
 * A token whose name carries `Wash` is a translucent highlight, not a colour
 * of its own (`theme.ts`: `pineWash`, `pineWashFaint` and `dangerWash` are one
 * neutral highlight, charcoal at 5% in light). It is the app's fill for a
 * pressed row on a known ground, and it is the wrong kind of colour for a
 * state: the platform composites it over whatever sits behind the control, so
 * what it measures against depends on the sheet, not on the palette.
 */
const WASH = /Wash/;

/**
 * The switch's second contract: whether the two states can be TOLD APART.
 * Names are what `missingOn` checks; this reads the values. It refuses four
 * shapes, and computes no contrast — a ratio would pin the palette's numbers
 * into a test that is not the palette's owner (`theme.contract.test.ts` is),
 * and would go stale the day a token moves. The shapes are what actually go
 * wrong.
 */
function stateFaultOn(el: Element): string | null {
  if (el.tag !== 'Switch') return null;
  const on = el.exprs['trackColor.true'];
  const off = el.exprs['trackColor.false'];
  const thumb = el.exprs.thumbColor;
  if (on === undefined || off === undefined)
    return 'trackColor names no true/false pair';
  if (on === off) return `both track states paint ${on}`;
  const wash = [on, off].filter(value => WASH.test(value)).join(' and ');
  if (wash !== '')
    return `${wash} is a wash — a tint that composites toward the sheet behind the control, not a state`;
  if (thumb !== undefined && thumb === on)
    return `the knob paints ${thumb}, the colour of the track it sits on when the switch is on`;
  return null;
}

/** `app/src/screens/Foo.tsx:120` — a place a person can open. */
const where = (el: Element): string =>
  `${el.file.replace(APP_ROOT, 'app').split('\\').join('/')}:${el.line}`;

const ALL: Element[] = productionFiles().flatMap(elementsIn);
const of = (tag: string): Element[] => ALL.filter(e => e.tag === tag);

describe('every text field is themed by the app, not by the platform', () => {
  it('the scanner really scans (it finds the known fields, not nothing)', () => {
    expect(of('TextInput').length).toBeGreaterThanOrEqual(FLOOR.TextInput);
  });

  it('every <TextInput carries keyboardAppearance, selectionColor and placeholderTextColor', () => {
    const short = of('TextInput')
      .filter(el => missingOn(el).length > 0)
      .map(el => `${where(el)} missing ${missingOn(el).join(', ')}`);
    expect(short).toEqual([]);
  });

  it('a spread does not satisfy the contract', () => {
    // Two fields legitimately spread a shared constant (`KEYBOARD_OFF` in
    // VaultSection: autoCorrect, spellCheck, autoComplete off). A spread is
    // allowed — what is not allowed is a spread standing IN for one of the
    // three, because an object assembled elsewhere is not a contract this
    // walk can read. So the predicate ignores spreads entirely and the props
    // must be written on the element.
    const planted = elementsInSource(
      'planted.tsx',
      'export const F = () => <TextInput {...THEMED} />;',
    );
    expect(planted).toHaveLength(1);
    expect(planted[0]!.spread).toBe(true);
    expect(missingOn(planted[0]!)).toEqual([
      'keyboardAppearance',
      'selectionColor',
      'placeholderTextColor',
    ]);
  });

  it('the sweep can actually fail (a field short one prop is caught)', () => {
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const F = () => (',
        '  <TextInput',
        '    placeholderTextColor={t.color.inkMuted}',
        '    selectionColor={t.color.pine}',
        '  />',
        ');',
      ].join('\n'),
    );
    expect(planted).toHaveLength(1);
    expect(missingOn(planted[0]!)).toEqual(['keyboardAppearance']);
  });

  it('a comment naming the prop does not count as carrying it', () => {
    // The reason this is a parse and not a grep: comments are trivia and are
    // never visited, so prose about the pattern cannot satisfy the pattern.
    const planted = elementsInSource(
      'planted.tsx',
      [
        '// keyboardAppearance selectionColor placeholderTextColor',
        'export const F = () => <TextInput />;',
      ].join('\n'),
    );
    expect(planted).toHaveLength(1);
    expect(missingOn(planted[0]!)).toEqual([
      'keyboardAppearance',
      'selectionColor',
      'placeholderTextColor',
    ]);
  });

  it('a prop set to nothing is not a prop (selectionColor={undefined})', () => {
    // Presence is not enough: `={undefined}` and `={false}` are written props
    // that pass nothing at runtime, and a net that counted them would wave
    // through the field that copied a conditional and lost the condition.
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const F = () => (',
        '  <TextInput',
        '    placeholderTextColor={t.color.inkMuted}',
        '    keyboardAppearance={t.scheme}',
        '    selectionColor={undefined}',
        '  />',
        ');',
      ].join('\n'),
    );
    expect(planted).toHaveLength(1);
    expect(missingOn(planted[0]!)).toEqual(['selectionColor']);
  });

  it('a namespaced tag is still governed (Animated.TextInput)', () => {
    const planted = elementsInSource(
      'planted.tsx',
      'export const F = () => <Animated.TextInput />;',
    );
    expect(planted).toHaveLength(1);
    expect(planted[0]!.tag).toBe('TextInput');
  });
});

describe('every switch is painted from the palette, not iOS system green', () => {
  it('the scanner really scans (it finds the known switches, not nothing)', () => {
    expect(of('Switch').length).toBeGreaterThanOrEqual(FLOOR.Switch);
  });

  it('every <Switch carries trackColor, thumbColor and ios_backgroundColor', () => {
    const short = of('Switch')
      .filter(el => missingOn(el).length > 0)
      .map(el => `${where(el)} missing ${missingOn(el).join(', ')}`);
    expect(short).toEqual([]);
  });

  it('the two track states are colours a person can tell apart', () => {
    // The prop being present is not the state being legible. A switch's track
    // IS its state indicator — knob position is the other half, on a ~31pt
    // control — and these three are the §4 discoverability consents, where
    // reading the state wrong means being findable when you thought you were
    // not. So: two different tokens, neither a wash, and a knob that is not
    // the colour of the track it sits on.
    const faults = of('Switch')
      .map(el => ({ el, fault: stateFaultOn(el) }))
      .filter(x => x.fault !== null)
      .map(x => `${where(x.el)} ${x.fault}`);
    expect(faults).toEqual([]);
  });

  it('the sweep can actually fail (an untinted switch is caught)', () => {
    const planted = elementsInSource(
      'planted.tsx',
      'export const S = () => <Switch value={on} onValueChange={set} />;',
    );
    expect(planted).toHaveLength(1);
    expect(missingOn(planted[0]!)).toEqual([
      'trackColor',
      'thumbColor',
      'ios_backgroundColor',
    ]);
  });

  it('the state rule can actually fail (a wash ON track is caught)', () => {
    // This planted source is exactly what shipped in this cluster's first
    // commit and exactly what its fix pass removed: every prop name present,
    // the contract above green, and the two states 1.05:1 apart in the light
    // palette with ON the lighter of the two. Kept as the falsifier so the
    // rule cannot be quietly weakened back to a name check.
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const S = () => (',
        '  <Switch',
        '    trackColor={{ false: t.color.paperInset, true: t.color.pineWash }}',
        '    thumbColor={t.color.pine}',
        '    ios_backgroundColor={t.color.paperInset}',
        '  />',
        ');',
      ].join('\n'),
    );
    expect(planted).toHaveLength(1);
    expect(missingOn(planted[0]!)).toEqual([]);
    expect(stateFaultOn(planted[0]!)).toContain('is a wash');
  });

  it('the state rule catches a track painted one colour twice', () => {
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const S = () => (',
        '  <Switch',
        '    trackColor={{ false: t.color.pine, true: t.color.pine }}',
        '    thumbColor={t.color.inkStrong}',
        '    ios_backgroundColor={t.color.paperInset}',
        '  />',
        ');',
      ].join('\n'),
    );
    expect(stateFaultOn(planted[0]!)).toBe(
      'both track states paint t.color.pine',
    );
  });

  it('the state rule catches a knob the colour of its own ON track', () => {
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const S = () => (',
        '  <Switch',
        '    trackColor={{ false: t.color.paperInset, true: t.color.pine }}',
        '    thumbColor={t.color.pine}',
        '    ios_backgroundColor={t.color.paperInset}',
        '  />',
        ');',
      ].join('\n'),
    );
    expect(stateFaultOn(planted[0]!)).toContain('the knob paints t.color.pine');
  });
});

/**
 * The rotor's stops, screen by screen. `RuledLabel` (with its `heading`
 * prop) is the same component in a section label and in a date divider, so
 * the two lists below are the whole design: what a VoiceOver user can jump
 * to, and what would flood the jump list if it were offered.
 *
 * Named by the `label` expression rather than a line number, so an edit above
 * a section does not move the pin.
 */
const ruled = (fileEnd: string): Element[] =>
  of(RULED).filter(el =>
    el.file
      .split('\\')
      .join('/')
      .endsWith('/' + fileEnd),
  );
const headingsOf = (els: Element[]): string[] =>
  els.filter(el => el.props.includes('heading')).map(el => el.labelExpr ?? '?');
const roleLessOf = (els: Element[]): string[] =>
  els
    .filter(el => !el.props.includes('heading'))
    .map(el => el.labelExpr ?? '?');

describe('the rotor gets sections, and only sections', () => {
  it('the thread offers no date divider as a heading', () => {
    // The regression that would actually hurt: the thread
    // already gives the unread divider and the round header their own
    // explicit header role, and a heading per day on top of that turns the
    // Headings rotor into the scroll it was meant to replace.
    const dividers = ruled('screens/ChatThreadScreen.tsx');
    expect(dividers.length).toBeGreaterThanOrEqual(3);
    expect(headingsOf(dividers)).toEqual([]);
  });

  it('Register offers its three how-it-works sections and not the consent label', () => {
    // The consent card is the one thing on that screen a person must read in
    // order. A rotor stop that skips INTO it is not a kindness.
    const labels = ruled('screens/RegisterScreen.tsx');
    expect(headingsOf(labels)).toEqual([
      'COPY.hiw[0].label',
      'COPY.hiw[1].label',
      'COPY.hiw[2].label',
    ]);
    expect(roleLessOf(labels)).toEqual(['COPY.consentLabel']);
  });

  it('the account screens offer their discoverability and downgrade sections', () => {
    expect(headingsOf(ruled('screens/AccountEmailScreen.tsx'))).toEqual([
      'ACCOUNTS_COPY.discoverableTitle',
      'ACCOUNTS_COPY.downgradeTitle',
    ]);
    expect(headingsOf(ruled('screens/AccountPhoneScreen.tsx'))).toEqual([
      'ACCOUNTS_PHONE_COPY.discoverableTitle',
    ]);
    // The username deck follows the email and phone decks' pattern (V3,
    // 2026-10-08): the ruled heading has its own title key, and the switch
    // row keeps `discoverableLabel` — so the held state no longer prints
    // 'Findable by username' twice.
    expect(headingsOf(ruled('screens/AccountUsernameScreen.tsx'))).toEqual([
      'ACCOUNTS_USERNAME_COPY.discoverableTitle',
    ]);
  });

  it('the device detail offers its slot label', () => {
    expect(headingsOf(ruled('screens/LinkedDevicesScreen.tsx'))).toEqual([
      'LINKING_COPY.slotLabel(detail.device.class)',
    ]);
  });

  it('the linking pair offers its one field label as a field label', () => {
    // LinkConfirmScreen:128 and LinkDeviceScreen:261 each render exactly one
    // RuledLabel, over the code entry on a short single-purpose sheet. That
    // is a field label, not a section — there is no second section on either
    // screen to jump to — so the role is withheld deliberately. Pinned here
    // because an unrecorded omission reads to the next person as a forgotten
    // one. (Both labels are hardcoded string literals rather than a COPY-deck
    // key, which the release's copy rule forbids; those screens are outside
    // this cluster's paths and the fix is recorded as owed in the handoff.)
    const confirm = ruled('screens/LinkConfirmScreen.tsx');
    expect(confirm).toHaveLength(1);
    expect(headingsOf(confirm)).toEqual([]);
    const device = ruled('screens/LinkDeviceScreen.tsx');
    expect(device).toHaveLength(1);
    expect(headingsOf(device)).toEqual([]);
  });

  it('a role written off is not a role (heading={false})', () => {
    // The shorthand `heading` and the absent prop are the two forms the tree
    // uses; `heading={false}` is the third form a hurried edit produces, and
    // it must land with the role-less half, not the headings.
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const F = () => (',
        '  <>',
        '    <RuledLabel label={COPY.a} heading={false} />',
        '    <RuledLabel label={COPY.b} heading />',
        '  </>',
        ');',
      ].join('\n'),
    );
    expect(headingsOf(planted)).toEqual(['COPY.b']);
    expect(roleLessOf(planted)).toEqual(['COPY.a']);
  });

  it('the walk can actually tell the two apart', () => {
    // Falsifier: the same parser, the same predicate, planted source. If
    // `heading` stopped being read the first array would come back empty and
    // every case above would pass by asserting nothing.
    const planted = elementsInSource(
      'planted.tsx',
      [
        'export const F = () => (',
        '  <>',
        '    <RuledLabel label={COPY.a} heading />',
        '    <RuledLabel label={COPY.b} />',
        '  </>',
        ');',
      ].join('\n'),
    );
    expect(headingsOf(planted)).toEqual(['COPY.a']);
    expect(roleLessOf(planted)).toEqual(['COPY.b']);
  });
});
