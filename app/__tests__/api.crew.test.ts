/**
 * The crew calls through the REAL wire seam.
 *
 * The machine-section tests mock the api layer, which is how the advertised
 * cap_reached and crew_contended sentences shipped UNREACHABLE: request()
 * parses error bodies through the shared strict ApiError schema, and both
 * codes were missing from its enum — safeParse failed, `code` stayed
 * undefined, and every crew refusal collapsed onto the default sentence.
 * These tests script fetch itself, so the parse the phone actually performs
 * is the parse under test; they FAIL if either code ever leaves the shared
 * enum again.
 */

import { ApiRequestError, apiCrewAdopt } from '../src/api';
import { machineFailureCopy } from '../src/machine';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scriptFetch(status: number, body: unknown) {
  globalThis.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

async function rejection(p: Promise<unknown>): Promise<ApiRequestError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiRequestError);
  return err as ApiRequestError;
}

describe('crew error codes survive the real response parse', () => {
  it('cap_reached arrives as itself, and the full-crew remedy renders', async () => {
    scriptFetch(409, {
      error: { code: 'cap_reached', detail: 'crew is full (max 8); revoke a member to free a slot' },
    });
    const err = await rejection(apiCrewAdopt('tok', '01BX5ZZKBKACTAV9WEVGEMMVRY'));
    expect(err.code).toBe('cap_reached');
    expect(machineFailureCopy(err)).toContain('full (8');
  });

  it('crew_contended arrives as itself, and the retry guidance renders', async () => {
    scriptFetch(503, {
      error: { code: 'crew_contended', detail: 'a concurrent adopt moved the crew; retry' },
    });
    const err = await rejection(apiCrewAdopt('tok', '01BX5ZZKBKACTAV9WEVGEMMVRY'));
    expect(err.code).toBe('crew_contended');
    expect(machineFailureCopy(err)).toContain('try again');
  });

  it('the collapsed refusal still arrives as itself (control)', async () => {
    scriptFetch(403, {
      error: { code: 'not_integration_owner', detail: 'not an integration you own' },
    });
    const err = await rejection(apiCrewAdopt('tok', '01BX5ZZKBKACTAV9WEVGEMMVRY'));
    expect(err.code).toBe('not_integration_owner');
  });

  it('204 resolves clean', async () => {
    scriptFetch(204, undefined);
    await expect(apiCrewAdopt('tok', '01BX5ZZKBKACTAV9WEVGEMMVRY')).resolves.toBeUndefined();
  });
});
