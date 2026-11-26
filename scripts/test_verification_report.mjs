import assert from 'node:assert/strict';
import test from 'node:test';
import { codecMeasurements, createVerificationReport, serializeVerificationReport } from '../sdk/verification-report.mjs';

test('strict decode distinguishes absent comparison from measured zero', () => {
  const report = createVerificationReport({
    host: 'workbench', status: 'passed',
    frame: { width: 2, height: 3, bits: 12, near: 0 },
    stages: { decode: 'passed' },
    memory: { decode: codecMeasurements({ outputQueueBytes: 0, outputPeakBytes: 112 }, 'worker') },
    stream: { rowsDelivered: 3, provisionalRows: 0, strictEoi: true },
  });
  assert.equal(report.frame.maxval, 4095);
  assert.deepEqual(report.samples, { total: 6, verified: null, maxError: null, errorBound: 0, unit: 'sample' });
  assert.equal(report.reference.status, 'not_run');
  assert.deepEqual(report.unexecuted, ['encode', 'compare', 'independent_reference']);
  assert.equal(report.memory.decode.outputPayloadPeakBytes, 112);
  assert.equal(report.memory.decode.lastOutputQueueBytes, 0);
  assert.equal(report.memory.decode.corePayloadBytes, null);
  assert.deepEqual(JSON.parse(serializeVerificationReport(report)), report);
});

test('a passing comparison requires measured errors within NEAR on every sample', () => {
  const fields = {
    host: 'sdk-cli', status: 'passed', stages: { compare: 'passed' },
    frame: { width: 2, height: 3, bits: 16, near: 0 },
  };
  assert.throws(() => createVerificationReport(fields), /every sample/);
  assert.throws(() => createVerificationReport({ ...fields, samples: { verified: 5, maxError: 0 } }), /every sample/);
  assert.throws(() => createVerificationReport({ ...fields, samples: { verified: 6, maxError: 1 } }), /within NEAR/);
  assert.equal(createVerificationReport({ ...fields, samples: { verified: 6, maxError: 0 } }).samples.maxError, 0);
});

test('sampled verification reports use real plane dimensions, offsets and scan mode', () => {
  const fields = {
    host: 'workbench', status: 'passed', stages: { decode: 'passed', compare: 'passed' },
    frame: {
      width: 9, height: 7, bits: 8, near: 0,
      components: [{ id: 10, hSampling: 1, vSampling: 2 }, { id: 20, h: 2, v: 1 }],
      scans: [{ componentIds: [10, 20], interleave: 1 }],
    },
    samples: { verified: 71, maxError: 0 },
  };
  const report = createVerificationReport(fields);
  assert.equal(report.frame.interleave, 1);
  assert.equal(report.frame.scans, 1);
  assert.deepEqual(report.frame.componentGeometry, [
    { id: 10, hSampling: 1, vSampling: 2, width: 5, height: 7, sampleOffset: 0 },
    { id: 20, hSampling: 2, vSampling: 1, width: 9, height: 4, sampleOffset: 35 },
  ]);
  assert.equal(report.samples.total, 71);
  assert.throws(() => createVerificationReport({ ...fields, samples: { verified: 126, maxError: 0 } }), /every sample/);
});
