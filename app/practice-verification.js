'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  const { verifyRuntime } = require('./practice-manifest');
  parentPort.postMessage(verifyRuntime(workerData.root));
} else {
  module.exports.verifyInWorker = root => {
    const worker = new Worker(__filename, { workerData: { root } });
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    worker.once('message', result => finish(result));
    worker.once('error', () => finish({ ok: false }));
    worker.once('exit', () => finish({ ok: false }));
    return { promise, cancel: () => { finish({ ok: false, cancelled: true }); worker.terminate(); } };
  };
}
