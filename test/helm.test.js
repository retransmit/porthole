import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Helm } from '../src/helm.js';

describe('Helm', () => {
  test('starts unheld', () => {
    assert.equal(new Helm().holder, null);
  });

  test('lets anyone type while the helm is unheld, which is the default', () => {
    const helm = new Helm();
    assert.equal(helm.canType('alice'), true);
    assert.equal(helm.canType('bob'), true);
  });

  test('grants the helm to the first claimant', () => {
    const helm = new Helm();
    assert.equal(helm.claim('alice'), true);
    assert.equal(helm.holder, 'alice');
  });

  test('restricts typing to the holder once claimed', () => {
    const helm = new Helm();
    helm.claim('alice');
    assert.equal(helm.canType('alice'), true);
    assert.equal(helm.canType('bob'), false);
  });

  test('refuses a claim while someone else holds it', () => {
    const helm = new Helm();
    helm.claim('alice');
    assert.equal(helm.claim('bob'), false);
    assert.equal(helm.holder, 'alice');
  });

  test('treats a re-claim by the current holder as success', () => {
    const helm = new Helm();
    helm.claim('alice');
    assert.equal(helm.claim('alice'), true);
    assert.equal(helm.holder, 'alice');
  });

  test('releases only for the holder', () => {
    const helm = new Helm();
    helm.claim('alice');
    assert.equal(helm.release('bob'), false);
    assert.equal(helm.holder, 'alice');
    assert.equal(helm.release('alice'), true);
    assert.equal(helm.holder, null);
  });

  test('returns to free-for-all after release', () => {
    const helm = new Helm();
    helm.claim('alice');
    helm.release('alice');
    assert.equal(helm.canType('bob'), true);
  });

  test('lets an admin seize the helm from the current holder', () => {
    const helm = new Helm();
    helm.claim('alice');
    assert.equal(helm.seize('bob'), true);
    assert.equal(helm.holder, 'bob');
    assert.equal(helm.canType('alice'), false);
  });

  test('frees the helm when the holder disconnects', () => {
    const helm = new Helm();
    helm.claim('alice');
    helm.disconnect('alice');
    assert.equal(helm.holder, null);
    assert.equal(helm.canType('bob'), true);
  });

  test('an unrelated disconnect leaves the helm alone', () => {
    const helm = new Helm();
    helm.claim('alice');
    helm.disconnect('bob');
    assert.equal(helm.holder, 'alice');
  });
});
