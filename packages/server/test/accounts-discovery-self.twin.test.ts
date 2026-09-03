import { it } from 'vitest';
import { makeMemoryDb } from './helpers.js';
import { selfDiscoverySuite } from './accounts-discovery-self.suite.js';

/**
 * SELF-DISCOVERY IS A MISS — the memory twin, which is store-blind and so
 * belongs in the `fast` project CI actually runs.
 *
 * The scenario itself is accounts-discovery-self.suite.ts, shared verbatim
 * with the DynamoDB Local leg in accounts-discovery-self.test.ts (`heavy`):
 * one function, two stores, so neither store can observe a different answer
 * and the two legs cannot drift into two scenarios.
 */

const memDb = makeMemoryDb();
memDb.setAccountsFeatureEnabled(true);
memDb.setAccountsPhoneFeatureEnabled(true);
memDb.setAccountsUsernameFeatureEnabled(true);

selfDiscoverySuite(
  'memory twin',
  () => memDb,
  (name, fn) => {
    it(name, fn);
  },
);
