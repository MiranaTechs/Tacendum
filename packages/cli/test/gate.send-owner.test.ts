import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * THE SEND SEQUENCE HAS ONE OWNER — the structural gate, rebuilt SOUND after
 * an external review defeated the text-matching version by
 * execution, three ways at once:
 *
 *   - `import { encryptText as advanceRatchet }` and calling the alias
 *     PASSED — the one thing the gate exists to catch;
 *   - a harmless STRING containing `encryptText(` FAILED the suite — a false
 *     alarm on data;
 *   - `.mts`/`.tsx` files were never scanned at all.
 *
 * A guard that misses the rename while firing on a string is worse than no
 * guard, because it gets trusted. The honest fork was: make it sound, or
 * delete it. It is KEPT, because the defect class it closes is this repo's
 * most-repeated one (a rule implemented at N call sites that then diverge —
 * the connect-before-ratchet order alone was found divergent four times), and
 * because the property CAN be checked soundly at the right altitude: you
 * cannot CALL a primitive you cannot NAME, and in an ES module, naming a
 * primitive defined elsewhere requires crossing a module boundary — an
 * import. So this gate parses every source file with the TypeScript AST and
 * closes the set of modules with ACCESS to the primitives:
 *
 *   - a named import records the ORIGINAL exported name, so an alias
 *     (`encryptText as advanceRatchet`) is caught by construction;
 *   - a namespace import (`* as m`), a default import, a dynamic
 *     `import('./messaging.js')` and a `require` of it grant access to
 *     everything, and are recorded as such;
 *   - `import type` grants no runtime access and is (correctly) not counted;
 *   - string literals and comments are data to a parser, so the false alarm
 *     class is gone by construction, not by a cleverer regex;
 *   - `.ts`, `.tsx`, `.mts` and `.cts` are all scanned;
 *   - re-exporting a primitive (named, aliased, or `export *` from
 *     messaging.ts) is forbidden EVERYWHERE — an allowed module must not
 *     launder the symbol into a module this gate does not track;
 *   - and so is re-exporting a LIBSIGNAL binding, in every spelling that
 *     hands out a NAME: `export { … } from '@signalapp/libsignal-client'`, a
 *     plain `export { x }`, `export const y = x`, and `export default x`, of
 *     a local name an import of that package bound. Being on the libsignal
 *     allowlist is permission to REACH the package, never permission to hand
 *     it on; an allowlisted module that re-exports `signalEncrypt` gives raw
 *     ratchet access to every module that imports the re-export, and both
 *     closed sets stay green. "Every spelling" was
 *     written here one round before it was true: `export default x` is a
 *     different NODE KIND from `export { x as default }`, and the walk below
 *     visited only the second until an earlier review — so the escape this
 *     bullet describes was open through the module this bullet warns about;
 *   - and because "rename the import" has a sibling one layer down —
 *     importing @signalapp/libsignal-client directly and advancing the
 *     ratchet without messaging.ts ever hearing about it — the libsignal
 *     package itself gets the same closed importer set.
 *
 * WHAT THIS GATE CLAIMS, exactly: the set of MODULES that can reach the
 * ratchet-advancing primitives is closed. It does not count call sites inside
 * an allowed module — the previous version claimed an "exact set" it never
 * checked; per-site behaviour is the behavioural suites' job (gate.send-unify,
 * setup.test.ts's send-order cases, gate.call-socket-liveness). What remains
 * out of reach, named so nobody trusts past it: eval/Function string tricks,
 * code that manipulates the session-store FILES without libsignal, an
 * export whose exported VALUE is not a bare identifier — `export const x =
 * pick()`, `export const x = sig.signalEncrypt`, and equally `export default
 * { enc: signalEncrypt }` or `export default sig.signalEncrypt`, which the
 * earlier default-export branch deliberately does NOT decide — and a
 * DYNAMIC binding that is not a bare identifier declared directly from the
 * call: a destructured `const { signalEncrypt } = require(…)` (caught only
 * when a destructured name happens to be one of messaging's two
 * primitives), an assignment to a variable declared elsewhere (`m = await
 * import(…)`), or a promise passed on unawaited all still GRANT access
 * where the call is seen, but bind no name the export walk can judge. The
 * specifier forms and the direct `export { alias }` / `export const x =
 * alias` / `export default alias` are decided for EVERY binding an import
 * statement creates — named, renamed, default or namespace, of messaging.ts
 * or of libsignal — and for the one dynamic shape that binds a bare
 * identifier in its own declaration, awaited or not. That sentence has
 * earned its precision the hard way twice: "every spelling" stood here one
 * round before `export default x` was visited, and
 * "decided" stood here while a namespace/default MESSAGING binding was
 * granted but never recorded, leaving all three direct forms undecided over
 * exactly that binding — a disclosure that is false
 * is not a disclosure. An expression is not decided, in any statement. All
 * of these are visible only to review, none expressible as an import.
 *
 * The analyzer's own guarantees are executable: the fixtures below are the
 * gate's exact probes, so a future "simplification" back toward text matching
 * fails here before it ships.
 */

const SRC = join(dirname(fileURLToPath(new URL(import.meta.url))), '..', 'src');

/** The primitives whose reachability is under guard. Both live in
 * messaging.ts; a vacuity test below proves they still exist there under
 * these names, so renaming one cannot quietly retire the gate. */
const RATCHET_PRIMITIVES = ['establishSession', 'encryptText'] as const;
type Primitive = (typeof RATCHET_PRIMITIVES)[number];

/**
 * Who may IMPORT each ratchet-advancing primitive, and why. Extending a list
 * is a claim that the new module upholds connect-before-ratchet itself — the
 * bar is call-session.ts: a call-site comment naming send.ts as the rule's
 * owner, an ENFORCED liveness gate (not an asserted invariant — an external
 * review disproved the "holds by construction" claim by execution), and
 * coverage proving a dead transport costs zero advances
 * (gate.call-socket-liveness.test.ts).
 *
 * send.ts is the owner: the one implementation of resolve, connect,
 * bootstrap-if-absent, encrypt, receipt. call-session.ts is the one
 * exemption: call signalling rides a persistent socket the answer and ICE
 * come back on, waits for no receipts, and carries the urgent bit, so it
 * cannot route through send.ts's one-shot dial — instead it enforces the
 * same invariant locally (assertSocketOpen before any ratchet work).
 * messaging.ts DEFINES the primitives and imports nothing from itself, so it
 * does not appear here.
 *
 * attend.ts (`realTypingChannel`) is the second exemption,
 * for `encryptText` ONLY — typing never bootstraps X3DH, so it has no claim
 * on `establishSession` and gets none. The argument, to the bar above:
 * typing chatter leaves as the relay-only `typing` frame — no msgId, no
 * receipt, no queue row — on one 'send'-role socket held for the turn, so it
 * cannot route through send.ts's one-shot receipt-waiting dial; the call
 * site names send.ts as the rule's owner, dials BEFORE any ratchet work and
 * enforces `ws.isOpen()` on the reuse path before each advance; and the
 * dead-transport tests in attend.typing.test.ts prove a dead socket costs
 * zero advances (gate.call-socket-liveness.test.ts's shape).
 */
const ALLOWED_IMPORTERS: Record<Primitive, string[]> = {
  establishSession: ['call-session.ts', 'send.ts'],
  encryptText: ['attend.ts', 'call-session.ts', 'send.ts'],
};

/**
 * Rule 1's floor: cryptography goes through libsignal, and libsignal is
 * reached from exactly these modules. A fifth importer is either a new
 * divergent copy of ratchet handling (route it through messaging.ts) or a
 * genuine extension of the crypto seam — which is a review event, not a
 * drive-by.
 *
 * doctor.ts IS SUCH A REVIEW EVENT, and here is the argument.
 *
 * The finding: doctor's identity check accepted any blob whose
 * `identityKeyPair` was a nonempty string, while every operational read
 * (`FileIdentityKeyStore.load` -> `parseCredential` -> `IdentityKeyPair.
 * deserialize`, stores.ts) additionally demands a numeric `registrationId` and
 * bytes libsignal will actually take. So a corrupted credential produced an
 * ENTIRELY GREEN report beside a store that refuses it — a false diagnostic in
 * the one command an operator runs when they already suspect something, which
 * is worse than no check.
 *
 * Why not route it through the seam. `messaging.ts` has no "would this
 * credential load" predicate to export, and building doctor's answer on
 * `FileIdentityKeyStore` is worse than a direct import rather than better: its
 * constructor `mkdirSync`s the peer directory, and doctor observes without
 * repairing — asking the question would create part of the store it is
 * reporting on. That is the rule this file's own docblock puts first.
 *
 * What the exemption actually admits, and why it is not the hazard this list
 * guards: doctor imports ONE symbol, `IdentityKeyPair`, and calls ONE method,
 * `deserialize`, on bytes it read read-only. It establishes no session,
 * encrypts nothing, advances no ratchet, writes no store, and touches no
 * socket — the send-sequence invariant this gate exists to protect has nothing
 * to bite on. The caught error is discarded, never rethrown and never
 * interpolated, because a deserialize failure quotes its input and its input is
 * the account's private key.
 *
 * And it does not become a second implementation by drift:
 * `gate.doctor-identity-conformance.test.ts` drives a corpus of blobs through
 * doctor and through a REAL `FileIdentityKeyStore`, requires the two verdicts
 * to agree, and requires each to be the expected one. The corpus spans real
 * keys across the registration-id range and each way a credential is
 * malformed, so tightening or loosening either side over any of those goes
 * red — which is as much as a corpus can say, and more than this sentence
 * used to be entitled to (it claimed ANY change went red; see the same
 * correction at `identityLoads` in doctor.ts, an earlier review).
 */
const ALLOWED_LIBSIGNAL_IMPORTERS = ['doctor.ts', 'inbound.ts', 'messaging.ts', 'stores.ts'];

const MESSAGING_SPECIFIER = /(^|\/)messaging(\.js|\.ts)?$/;
const LIBSIGNAL_PACKAGE = '@signalapp/libsignal-client';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
function isSourceFile(name: string): boolean {
  // .d.ts is ambient — it cannot import at runtime — but costs nothing to
  // scan and a declaration file naming these primitives would be strange
  // enough to want flagged. So: no exclusion.
  return SOURCE_EXTENSIONS.some(ext => name.endsWith(ext));
}

/** Every scannable file under src, as paths relative to src. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (isSourceFile(entry.name)) out.push(relative(SRC, path));
  }
  return out.sort();
}

interface RatchetAccess {
  /** Primitives this module can name at runtime, however aliased. */
  primitives: Set<Primitive>;
  /** The module imports @signalapp/libsignal-client (any subpath). */
  libsignal: boolean;
  /** Human-readable descriptions of forbidden re-export statements. */
  launders: string[];
}

function isMessagingSpecifier(spec: string): boolean {
  return MESSAGING_SPECIFIER.test(spec);
}
function isLibsignalSpecifier(spec: string): boolean {
  return spec === LIBSIGNAL_PACKAGE || spec.startsWith(`${LIBSIGNAL_PACKAGE}/`);
}

/**
 * Parse one module and report its access to the guarded primitives. Pure
 * function of the source text, so the fixtures below can feed it the gate's
 * probes directly.
 */
function ratchetAccessOf(source: string, fileName: string): RatchetAccess {
  const access: RatchetAccess = { primitives: new Set(), libsignal: false, launders: [] };
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const grantAll = (): void => {
    for (const p of RATCHET_PRIMITIVES) access.primitives.add(p);
  };
  /** Local aliases bound to a primitive by an import in THIS file, so a
   * local `export { alias }` further down is recognized as laundering. */
  const primitiveAliases = new Set<string>();
  /**
   * Local aliases bound to ANY libsignal export by an import in THIS file —
   * the same idea one layer down, and the hole an earlier review came
   * through. `primitiveAliases` can only know messaging.ts's two names, and
   * libsignal's own exports are not among them, so an allowlisted importer
   * exporting its own `signalEncrypt` binding laundered the raw ratchet
   * primitive past both closed sets. Identity comes from the SPECIFIER here,
   * exactly as it does in the import branch: whatever an `import … from
   * '@signalapp/libsignal-client'` binds locally — default, namespace, named,
   * renamed — is libsignal, under any name, and exporting it is laundering.
   */
  const libsignalAliases = new Set<string>();

  /**
   * TWO PASSES, and the reason is hoisting. `export { x }` is legal ABOVE the
   * `import` that binds `x`, and a single lexical walk would visit the export
   * before the alias sets were populated and report nothing. Every import is
   * collected first; only then are the exports judged.
   */
  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      // `import 'x'` binds nothing; `import type` binds no runtime value.
      const runtime = clause !== undefined && !clause.isTypeOnly;
      if (isLibsignalSpecifier(spec) && !(clause?.isTypeOnly ?? false)) {
        access.libsignal = true;
      }
      if (isLibsignalSpecifier(spec) && runtime && clause) {
        if (clause.name) libsignalAliases.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            libsignalAliases.add(clause.namedBindings.name.text);
          } else {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              libsignalAliases.add(element.name.text);
            }
          }
        }
      }
      if (isMessagingSpecifier(spec) && runtime && clause) {
        // A default or namespace import can reach every export — and its
        // LOCAL NAME is recorded beside the grant, exactly as the libsignal
        // branch above has always done. Granting without recording is round
        // 22, an earlier finding: `guardedLocal('m')` answered false for
        // `import * as m from './messaging.js'`, so every export spelling
        // of `m` laundered both primitives with `launders: []` — from an
        // allow-listed module, to any module this gate never tracks.
        if (clause.name) {
          grantAll();
          primitiveAliases.add(clause.name.text);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            grantAll();
            primitiveAliases.add(clause.namedBindings.name.text);
          } else {
            for (const element of clause.namedBindings.elements) {
              if (element.isTypeOnly) continue;
              const original = (element.propertyName ?? element.name).text;
              if ((RATCHET_PRIMITIVES as readonly string[]).includes(original)) {
                access.primitives.add(original as Primitive);
                primitiveAliases.add(element.name.text);
              }
            }
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      // Dynamic access: `import('./messaging.js')` / `require(...)`. Only a
      // string-literal specifier is decidable; a computed one cannot name
      // this module in this codebase without also tripping review.
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteralLike(arg)) {
          if (isMessagingSpecifier(arg.text)) grantAll();
          if (isLibsignalSpecifier(arg.text)) access.libsignal = true;
        }
      }
    }
    // The dynamic BINDING, where one exists to record (an earlier review's
    // second half): the branch above grants access for the CALL, but
    // `const m = await import('./messaging.js')` also binds a bare
    // identifier — the same laundering handle an `import * as m` creates —
    // and nothing recorded it. Decided for exactly the shape that is
    // decidable at this altitude: an identifier declared directly from the
    // call, awaited or not. A destructured dynamic binding, an assignment to
    // a variable declared elsewhere, or a promise passed on unawaited binds
    // no name this walk can judge, and the docblock's residual says so.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression;
      }
      if (ts.isCallExpression(init)) {
        const isDynamicImport = init.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(init.expression) && init.expression.text === 'require';
        const arg = init.arguments[0];
        if ((isDynamicImport || isRequire) && arg !== undefined && ts.isStringLiteralLike(arg)) {
          if (isMessagingSpecifier(arg.text)) primitiveAliases.add(node.name.text);
          if (isLibsignalSpecifier(arg.text)) libsignalAliases.add(node.name.text);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };

  /** A local binding whose export hands a tracked module's runtime value out. */
  const guardedLocal = (name: string): boolean =>
    (RATCHET_PRIMITIVES as readonly string[]).includes(name) ||
    primitiveAliases.has(name) ||
    libsignalAliases.has(name);

  const collectExports = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) {
      const spec =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
      // TYPE-ONLY IS A PROPERTY OF THE SPECIFIER AS WELL AS THE DECLARATION
      //. `export type { X } from …` sets the
      // declaration's flag; `export { type X } from …` sets only the
      // specifier's, and the declaration's stays false. Both are erased, so
      // both must be. A clause with NO clause at all (`export * from`) or a
      // namespace re-export (`export * as ns from`) is a runtime binding
      // unless the declaration itself is type-only.
      const runtimeSpecifiers =
        node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.filter(e => !e.isTypeOnly)
          : null;
      const runtimeReexport =
        !node.isTypeOnly && (runtimeSpecifiers === null || runtimeSpecifiers.length > 0);
      // A RE-EXPORT FROM LIBSIGNAL IS LIBSIGNAL ACCESS, whatever either side
      // calls it — the same rule the import branch has always applied, and
      // the branch below did not. It flagged only names
      // it recognized, and the names it recognizes are messaging.ts's two
      // primitives; libsignal's own exports are not among them, so
      // `export { signalEncrypt as harmless } from '@signalapp/libsignal-
      // client'` set nothing and BOTH assertions stayed green over a module
      // handing the ratchet primitive to anyone who imports it.
      if (spec !== null && isLibsignalSpecifier(spec) && runtimeReexport) {
        access.libsignal = true;
      }
      if (spec !== null && (isMessagingSpecifier(spec) || isLibsignalSpecifier(spec))) {
        // `export * from` or `export { … } from` a guarded module: whether or
        // not a primitive is named, this creates a second module the guard
        // would have to track forever. Forbidden outright — and forbidden for
        // LIBSIGNAL's exports too, not just messaging.ts's two primitives.
        // Being on ALLOWED_LIBSIGNAL_IMPORTERS is permission to REACH the
        // package; it was never permission to re-export it, and the
        // name-matching branch that stood here let an allowlisted module do
        // exactly that.
        if (!node.exportClause) {
          if (runtimeReexport) access.launders.push(`export * from '${spec}'`);
        } else if (ts.isNamespaceExport(node.exportClause)) {
          if (runtimeReexport) {
            access.launders.push(`export * as ${node.exportClause.name.text} from '${spec}'`);
          }
        } else if (runtimeSpecifiers !== null) {
          for (const element of runtimeSpecifiers) {
            const original = (element.propertyName ?? element.name).text;
            if (isLibsignalSpecifier(spec) || guardedLocal(original) || guardedLocal(element.name.text)) {
              access.launders.push(`export { ${original} } from '${spec}'`);
            }
          }
        }
      } else if (spec === null && runtimeSpecifiers !== null) {
        for (const element of runtimeSpecifiers) {
          const local = (element.propertyName ?? element.name).text;
          const exported = element.name.text;
          if (guardedLocal(local) || guardedLocal(exported)) {
            access.launders.push(`export { ${local} as ${exported} }`);
          }
        }
      }
    }
    // `export const harmless = signalEncrypt;` — the initializer form. Only a
    // bare identifier is decided here (the brief the analyzer keeps: what it
    // can SEE, it judges; what it cannot, it does not pretend to). A computed
    // or property-access initializer is out of reach and stays a review
    // matter, named in the docblock.
    if (
      ts.isVariableStatement(node) &&
      (node.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (init !== undefined && ts.isIdentifier(init) && guardedLocal(init.text)) {
          const name = ts.isIdentifier(decl.name) ? decl.name.text : '<pattern>';
          access.launders.push(`export const ${name} = ${init.text}`);
        }
      }
    }
    // `export default signalEncrypt;` — the SAME STATEMENT as the
    // `export { signalEncrypt as default }` the specifier branch above
    // decides, in the spelling ESM actually uses, and for two rounds this
    // walk judged only one of the two. A default export is a
    // `ts.ExportAssignment`, which matches NEITHER node shape above, so an
    // already-allowlisted module (`stores.ts`) could add two lines and hand
    // the raw ratchet primitive to any untracked importer with `launders`
    // empty and both closed sets green.
    //
    // Bare identifier only, on the same brief as the initializer branch
    // above: `export default { enc: signalEncrypt }` is an expression this
    // analyzer does not decide, and is named in the docblock's residual
    // rather than silently implied.
    //
    // `isExportEquals` is what separates `export = x` from `export default x`
    // at this one node kind. `export =` cannot occur in this package —
    // packages/cli is `"type": "module"` compiled as NodeNext, where it is
    // TS1203 (verified by compiling one) — but the flag is CHECKED rather
    // than assumed, because the clause costs nothing and treating a CommonJS
    // export assignment as a default export would be a silent wrong answer.
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const exported = node.expression;
      if (ts.isIdentifier(exported) && guardedLocal(exported.text)) {
        access.launders.push(`export default ${exported.text}`);
      }
    }
    ts.forEachChild(node, collectExports);
  };

  ts.forEachChild(sourceFile, collectImports);
  ts.forEachChild(sourceFile, collectExports);
  return access;
}

const files = sourceFiles(SRC);
const accessByFile = new Map<string, RatchetAccess>(
  files.map(file => [file, ratchetAccessOf(readFileSync(join(SRC, file), 'utf8'), file)]),
);

describe('the analyzer itself — the adversarial probes, kept executable', () => {
  it('catches a renamed import (a probe the old analyzer let through every time)', () => {
    const access = ratchetAccessOf(
      `import { encryptText as advanceRatchet } from './messaging.js';\n` +
        `advanceRatchet(stores, me, peer, body);\n`,
      'probe.ts',
    );
    expect([...access.primitives]).toEqual(['encryptText']);
  });

  it('catches namespace, default and dynamic imports (full access, conservatively)', () => {
    for (const source of [
      `import * as m from './messaging.js';`,
      `import messaging from '../messaging.js';`,
      `const m = await import('./messaging.js');`,
      `const m = require('./messaging.js');`,
    ]) {
      const access = ratchetAccessOf(source, 'probe.ts');
      expect([...access.primitives].sort(), source).toEqual(
        [...RATCHET_PRIMITIVES].sort(),
      );
    }
  });

  it('is silent on strings, comments and prose (the probe the old gate failed)', () => {
    const access = ratchetAccessOf(
      `const banner = 'never call encryptText( or establishSession( directly';\n` +
        `// prose: encryptText(stores, …) advances the ratchet\n` +
        `/* establishSession( is owned by send.ts */\n`,
      'probe.ts',
    );
    expect(access.primitives.size).toBe(0);
    expect(access.libsignal).toBe(false);
    expect(access.launders).toEqual([]);
  });

  it('is silent on type-only imports — they grant no runtime access', () => {
    const access = ratchetAccessOf(
      `import type { encryptText } from './messaging.js';\n` +
        `import { hasSession, type establishSession } from './messaging.js';\n`,
      'probe.ts',
    );
    expect(access.primitives.size).toBe(0);
  });

  it('flags re-exports that would launder a primitive out of the tracked graph', () => {
    for (const source of [
      `export { encryptText } from './messaging.js';`,
      `export { encryptText as harmlessName } from './messaging.js';`,
      `export * from './messaging.js';`,
      `export * from '@signalapp/libsignal-client';`,
      `import { establishSession as boot } from './messaging.js';\nexport { boot };`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').launders.length, source).toBeGreaterThan(0);
    }
  });

  /**
   * an earlier review: THE EXPORT BRANCH ONLY LOOKED AT NAMES IT
   * ALREADY KNEW.
   *
   * The import branch records libsignal access from the SPECIFIER, so an
   * alias cannot hide it. The export branch did not: it flagged
   * `export … from` a guarded module only when the local or exported name was
   * one of the two ratchet primitives — names that live in messaging.ts, not
   * in libsignal — so `export { signalEncrypt as harmless } from
   * '@signalapp/libsignal-client'` set nothing at all. `access.libsignal`
   * stayed false, `launders` stayed empty, and BOTH assertions passed while
   * an unlisted module handed the ratchet primitive to anyone who imported
   * it. Reproduced by putting exactly that file in src: the whole file was
   * still 11/11 green.
   *
   * A re-export from libsignal is libsignal access, whatever it is called on
   * either side — which is the same rule the import branch has always had.
   */
  it('an export-from libsignal is libsignal ACCESS, whatever the local name', () => {
    for (const source of [
      `export { signalEncrypt as harmless } from '@signalapp/libsignal-client';`,
      `export { signalEncrypt } from '@signalapp/libsignal-client';`,
      `export { PrivateKey as K, PublicKey } from '@signalapp/libsignal-client';`,
      `export * from '@signalapp/libsignal-client';`,
      `export { Aci } from '@signalapp/libsignal-client/dist/Address';`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').libsignal, source).toBe(true);
    }
  });

  it('…but `export type … from` grants no runtime access, exactly as `import type` does not', () => {
    expect(
      ratchetAccessOf(
        `export type { PrivateKey } from '@signalapp/libsignal-client';`,
        'probe.ts',
      ).libsignal,
    ).toBe(false);
  });

  /**
   * an earlier review: TYPE-ONLY IS A PROPERTY OF THE SPECIFIER TOO.
   *
   * `export { type PublicKey } from '@signalapp/libsignal-client'` is erased at
   * compile time exactly as `export type { PublicKey } from …` is — but the
   * DECLARATION's `isTypeOnly` is false for it; only the individual export
   * specifier carries the flag. The branch tested above read the declaration
   * alone, so the legal per-specifier spelling was reported as runtime
   * libsignal access and would have failed the closed-set assertion for a file
   * that imports nothing at runtime. The import side has always had this right
   * (`element.isTypeOnly` in the named-import loop); this is the export side
   * catching up.
   *
   * A MIXED CLAUSE IS STILL ACCESS, which is the half that keeps the fix from
   * becoming a hole: one runtime specifier beside a type-only one re-exports a
   * runtime binding, and the whole declaration counts.
   */
  it('a SPECIFIER-level type-only re-export is erased too — but a mixed clause is not', () => {
    for (const source of [
      `export { type PublicKey } from '@signalapp/libsignal-client';`,
      `export { type PublicKey, type PrivateKey } from '@signalapp/libsignal-client';`,
      `export type * from '@signalapp/libsignal-client';`,
      `export type * as sig from '@signalapp/libsignal-client';`,
    ]) {
      const access = ratchetAccessOf(source, 'probe.ts');
      expect(access.libsignal, source).toBe(false);
      // …and an erased re-export launders nothing either: there is no runtime
      // binding for a consumer to import.
      expect(access.launders, source).toEqual([]);
    }
    for (const source of [
      `export { type PublicKey, PrivateKey } from '@signalapp/libsignal-client';`,
      `export * as sig from '@signalapp/libsignal-client';`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').libsignal, source).toBe(true);
    }
  });

  /**
   * an earlier review: RE-EXPORT LAUNDERING THROUGH AN ALLOWLISTED
   * IMPORTER.
   *
   * The escape, in three lines and entirely legal TypeScript: `messaging.ts`
   * already imports libsignal and is already on ALLOWED_LIBSIGNAL_IMPORTERS, so
   * it adds `export { signalEncrypt as harmless };` — a plain export of its own
   * local binding, with NO `from` clause — and any module at all imports
   * `harmless` from it. Nothing moved: the exporting module's `libsignal` flag
   * was already true and is unchanged, the importing module's specifier is
   * `./messaging.js` rather than the package, and `signalEncrypt` is not one of
   * the two ratchet primitives the local-export branch matched on. Both closed
   * sets stayed green over a module handing the raw ratchet primitive to
   * anything that asks.
   *
   * The fix is the one the IMPORT branch has always had: identity is taken from
   * the SPECIFIER, not from a list of known names. Every local binding an
   * import of libsignal creates — default, namespace, named, renamed — is
   * recorded, and exporting one of them is laundering wherever it happens,
   * including from an allowlisted module. Reaching libsignal is a listed
   * privilege; re-exporting it hands that privilege to modules this gate does
   * not track, which is the thing a closed set cannot survive.
   */
  it('exporting a local libsignal binding is laundering, even from an allowlisted importer', () => {
    for (const source of [
      // The reviewer's exact construction.
      `import { signalEncrypt } from '@signalapp/libsignal-client';\nexport { signalEncrypt as harmless };`,
      // …and the other spellings that hand out the same binding BY NAME.
      // (Not "every other spelling": an exported EXPRESSION carrying the
      // binding — `export default { enc: signalEncrypt }` — is out of reach
      // by design and is named in the docblock's residual. This comment said
      // "every" for two rounds while `export default enc` was missing.)
      `import { signalEncrypt as enc } from '@signalapp/libsignal-client';\nexport { enc };`,
      `import { signalEncrypt as enc } from '@signalapp/libsignal-client';\nexport { enc as harmless };`,
      `import * as sig from '@signalapp/libsignal-client';\nexport { sig };`,
      `import sig from '@signalapp/libsignal-client';\nexport { sig as harmless };`,
      `import { signalEncrypt } from '@signalapp/libsignal-client';\nexport const harmless = signalEncrypt;`,
      // The export placed ABOVE the import it launders — legal, hoisted, and
      // invisible to a single lexical pass.
      `export { signalEncrypt as harmless };\nimport { signalEncrypt } from '@signalapp/libsignal-client';`,
      // The `from` spelling of the same escape: an earlier revision made this libsignal
      // ACCESS, which an allowlisted module already has.
      `export { signalEncrypt as harmless } from '@signalapp/libsignal-client';`,
      // `export default <identifier>` — the SAME STATEMENT as an
      // `export { signalEncrypt as default }`, which the specifier cases above
      // already decide, in the spelling ESM actually uses; for two rounds the
      // analyzer judged only one of the two. It is a
      // `ts.ExportAssignment`, not a `ts.ExportDeclaration`, so it matched
      // neither node shape `collectExports` visited: `stores.ts` — already
      // allowlisted for libsignal — could add these two lines and let any
      // untracked module do `import enc from './stores.js'` and advance the
      // ratchet, with `launders` empty and both closed-set assertions green.
      // Reproduced by planting exactly that in src/stores.ts beside a consumer
      // module: the whole file was still 15/15 green.
      `import { signalEncrypt } from '@signalapp/libsignal-client';\nexport default signalEncrypt;`,
      `import { signalEncrypt as enc } from '@signalapp/libsignal-client';\nexport default enc;`,
      `import * as sig from '@signalapp/libsignal-client';\nexport default sig;`,
      // …and the same escape one layer up, through a module on
      // ALLOWED_IMPORTERS rather than ALLOWED_LIBSIGNAL_IMPORTERS.
      `import { encryptText } from './messaging.js';\nexport default encryptText;`,
      `import { encryptText as advanceRatchet } from './messaging.js';\nexport default advanceRatchet;`,
      // Hoisted, like the `export { … }` case above it: the default export
      // written ABOVE the import it launders is legal, and only the two-pass
      // walk sees it.
      `export default signalEncrypt;\nimport { signalEncrypt } from '@signalapp/libsignal-client';`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').launders.length, source).toBeGreaterThan(0);
    }
    // The laundered SYMBOL is named, not merely the file: the failure message
    // has to tell whoever reads it which export to delete.
    expect(
      ratchetAccessOf(
        `import { signalEncrypt } from '@signalapp/libsignal-client';\nexport { signalEncrypt as harmless };`,
        'probe.ts',
      ).launders.join('; '),
    ).toContain('signalEncrypt');
    // …and a type-only import creates no runtime binding to launder.
    expect(
      ratchetAccessOf(
        `import type { PublicKey } from '@signalapp/libsignal-client';\nexport { PublicKey };`,
        'probe.ts',
      ).launders,
    ).toEqual([]);
    // The default form names its symbol too — `export default` on its own
    // would tell a reader nothing about which line to delete.
    expect(
      ratchetAccessOf(
        `import { signalEncrypt } from '@signalapp/libsignal-client';\nexport default signalEncrypt;`,
        'probe.ts',
      ).launders.join('; '),
    ).toContain('signalEncrypt');
    // LIVENESS for the default branch: it fires on the guarded BINDING, not on
    // the statement shape. A default export of anything this gate does not
    // track launders nothing — otherwise the branch would be a blanket ban on
    // default exports wearing a ratchet argument, and the next person to hit
    // the false alarm would delete it.
    for (const source of [
      `const helper = () => 1;\nexport default helper;`,
      `import { readFileSync } from 'node:fs';\nexport default readFileSync;`,
      `export default 42;`,
      `import type { PublicKey } from '@signalapp/libsignal-client';\nexport default PublicKey;`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').launders, source).toEqual([]);
    }
  });

  /**
   * an earlier review: THE MESSAGING BRANCH GRANTED WITHOUT
   * RECORDING.
   *
   * The libsignal import branch adds every binding shape to
   * `libsignalAliases`; the messaging branch called `grantAll()` for a
   * default import and for a namespace import and recorded NOTHING — only
   * the named-specifier loop fed `primitiveAliases`. So `guardedLocal('m')`
   * answered false for `import * as m from './messaging.js'`, and every
   * export spelling of `m` — `export { m }`, `export const x = m`,
   * `export default m` — yielded `launders: []`. The escape, reproduced
   * in-tree with the whole file green: send.ts (allow-listed) adds
   * `import * as m from './messaging.js'; export { m };`, and any untracked
   * module does `import { m } from './send.js'` and calls `m.encryptText(...)`
   * — the identical function object, no connect-before-ratchet gate, from a
   * module this gate never sees. Worse, the docblock's residual claimed the
   * direct bare-identifier export forms were "decided" — false over exactly
   * this binding, which is the one condition making a disclosed limit a
   * finding.
   *
   * The fix is the libsignal branch's own rule applied to its sibling:
   * record the local name beside every grantAll. The dynamic branch had the
   * same gap one shape removed — `const m = await import('./messaging.js')`
   * binds a bare identifier too — and gets the same mirror for exactly that
   * declaration shape (identifier initialized from the call, awaited or
   * not); what it still cannot see is named in the docblock's residual.
   */
  it('a namespace or default MESSAGING binding is recorded, so exporting it launders', () => {
    for (const source of [
      // The reviewer's exact construction, and its default-import sibling —
      // the messaging mirrors of the libsignal fixtures above.
      `import * as m from './messaging.js';\nexport { m };`,
      `import m from './messaging.js';\nexport { m as harmless };`,
      `import * as m from './messaging.js';\nexport { m as harmless };`,
      `import * as m from './messaging.js';\nexport const x = m;`,
      `import * as m from './messaging.js';\nexport default m;`,
      `import m from './messaging.js';\nexport default m;`,
      // Hoisted, like every other export fixture: legal, and only the
      // two-pass walk sees it.
      `export { m };\nimport * as m from './messaging.js';`,
      // The dynamic spellings of the same bare-identifier binding.
      `const m = await import('./messaging.js');\nexport { m };`,
      `const m = require('./messaging.js');\nexport default m;`,
      `const m = await import('./messaging.js');\nexport const x = m;`,
      // …and the libsignal side of the dynamic gap, same rule.
      `const sig = require('@signalapp/libsignal-client');\nexport { sig };`,
      `const sig = await import('@signalapp/libsignal-client');\nexport default sig;`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').launders.length, source).toBeGreaterThan(0);
    }
    // The laundered symbol is named, so the failure message says which
    // export to delete.
    expect(
      ratchetAccessOf(
        `import * as m from './messaging.js';\nexport { m };`,
        'probe.ts',
      ).launders.join('; '),
    ).toContain('m');
    // LIVENESS: the binding fires, not the statement shape. A namespace
    // import kept private launders nothing; an unrelated namespace export
    // launders nothing; a type-only namespace binds no runtime value.
    for (const source of [
      `import * as m from './messaging.js';\nconst x = m.hasSession;`,
      `import * as fs from 'node:fs';\nexport { fs };`,
      `import type * as m from './messaging.js';\nexport { m };`,
      `const other = require('node:os');\nexport { other };`,
    ]) {
      expect(ratchetAccessOf(source, 'probe.ts').launders, source).toEqual([]);
    }
  });

  it('scans .mts and .tsx spellings (the extensions the old gate ignored)', () => {
    expect(isSourceFile('a.mts')).toBe(true);
    expect(isSourceFile('a.cts')).toBe(true);
    expect(isSourceFile('a.tsx')).toBe(true);
    expect(isSourceFile('a.ts')).toBe(true);
    expect(isSourceFile('a.js.map')).toBe(false);
    expect(isSourceFile('a.json')).toBe(false);
  });
});

describe('the ratchet-advancing primitives have a closed importer set', () => {
  it('finds the source tree, and messaging.ts still exports both primitives under these names', () => {
    expect(files).toContain('send.ts');
    expect(files).toContain('messaging.ts');
    // Vacuity: if a primitive is renamed, this gate must be UPDATED, not
    // quietly satisfied — an import scan for a name nothing exports would
    // pass forever.
    const messaging = ts.createSourceFile(
      'messaging.ts',
      readFileSync(join(SRC, 'messaging.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const exported = new Set<string>();
    messaging.forEachChild(node => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
      ) {
        exported.add(node.name.text);
      }
    });
    for (const primitive of RATCHET_PRIMITIVES) {
      expect(exported, `messaging.ts no longer exports ${primitive}`).toContain(primitive);
    }
  });

  for (const primitive of RATCHET_PRIMITIVES) {
    const allowed = ALLOWED_IMPORTERS[primitive];
    it(`${primitive} is importable only from: ${allowed.join(', ')}`, () => {
      const importers = files.filter(file =>
        (accessByFile.get(file) as RatchetAccess).primitives.has(primitive),
      );
      const unexpected = importers.filter(f => !allowed.includes(f));
      const missing = allowed.filter(f => !importers.includes(f));
      expect(
        unexpected,
        `${unexpected.join(', ')} imports ${primitive} outside the allowed set. ` +
          `The send sequence (connect BEFORE any ratchet work) has one owner: ` +
          `sendEncrypted / sendEncryptedAll in src/send.ts. Route the new send ` +
          `through it — or, if the transport genuinely differs (see ` +
          `call-session.ts's exemption for the bar), add the file to ` +
          `ALLOWED_IMPORTERS with the justification, an ENFORCED liveness ` +
          `gate at the call site, and a test proving a dead transport costs ` +
          `zero advances (gate.call-socket-liveness.test.ts is the model).`,
      ).toEqual([]);
      expect(
        missing,
        `${missing.join(', ')} no longer imports ${primitive} — if that fold was ` +
          `intentional, shrink ALLOWED_IMPORTERS so the set stays exact.`,
      ).toEqual([]);
    });
  }

  it('no module re-exports a primitive or star-exports a guarded module', () => {
    const laundering = files
      .map(file => ({ file, launders: (accessByFile.get(file) as RatchetAccess).launders }))
      .filter(({ launders }) => launders.length > 0);
    expect(
      laundering.map(l => `${l.file}: ${l.launders.join('; ')}`),
      'a re-export creates a second reachable module this gate does not track — import from messaging.ts in an allowed module instead',
    ).toEqual([]);
  });

  it(`@signalapp/libsignal-client is importable only from: ${ALLOWED_LIBSIGNAL_IMPORTERS.join(', ')}`, () => {
    const importers = files.filter(file => (accessByFile.get(file) as RatchetAccess).libsignal);
    const unexpected = importers.filter(f => !ALLOWED_LIBSIGNAL_IMPORTERS.includes(f));
    const missing = ALLOWED_LIBSIGNAL_IMPORTERS.filter(f => !importers.includes(f));
    expect(
      unexpected,
      `${unexpected.join(', ')} imports libsignal directly. Rule 1's seam is ` +
        `messaging.ts (with stores.ts for the store interfaces and inbound.ts ` +
        `for error classification) — a direct import is how the ratchet gets ` +
        `advanced without the send owner ever hearing about it. Go through ` +
        `messaging.ts, or extend ALLOWED_LIBSIGNAL_IMPORTERS with the argument.`,
    ).toEqual([]);
    expect(
      missing,
      `${missing.join(', ')} no longer imports libsignal — shrink ` +
        `ALLOWED_LIBSIGNAL_IMPORTERS so the set stays exact.`,
    ).toEqual([]);
  });
});
