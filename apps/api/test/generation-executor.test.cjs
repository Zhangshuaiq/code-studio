const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyKubernetesFailure } = require('../dist/agent/generation-executor.service.js');

const job = (reason) => ({ status: reason ? { conditions: [{ reason }] } : {} });
const pod = ({ waiting, terminated, podReason } = {}) => ({
  status: {
    reason: podReason,
    containerStatuses: [{ state: { waiting, terminated } }],
  },
});

test('Kubernetes generation failure classifies image pull before deadline', () => {
  assert.equal(classifyKubernetesFailure(job('DeadlineExceeded'), [
    pod({ waiting: { reason: 'ImagePullBackOff' } }),
  ]), 'image_pull');
});

test('Kubernetes generation failure classifies OOM, eviction and deadline', () => {
  assert.equal(classifyKubernetesFailure(job(), [pod({ terminated: { reason: 'OOMKilled', exitCode: 137 } })]), 'oom_killed');
  assert.equal(classifyKubernetesFailure(job(), [pod({ podReason: 'Evicted' })]), 'evicted');
  assert.equal(classifyKubernetesFailure(job('DeadlineExceeded'), []), 'deadline_exceeded');
});

test('Kubernetes generation failure distinguishes command and unknown job failures', () => {
  assert.equal(classifyKubernetesFailure(job(), [pod({ terminated: { reason: 'Error', exitCode: 2 } })]), 'command_failed');
  assert.equal(classifyKubernetesFailure(job(), []), 'job_failed');
});
