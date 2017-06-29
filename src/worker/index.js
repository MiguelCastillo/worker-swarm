"use strict";

var path = require("path");
var childProcess = require("child_process");
var States = require("./states");

const defaults = {
  cwd: process.cwd(),
  env: process.env
};

class Worker {
  constructor(pool, options) {
    options = options || {};
    this.settings = Object.assign({}, defaults, options);
    this.pool = pool;
    this.pending = {};
    this.jobs = [];
    this.state = States.available;
    this.process = childProcess.fork(path.join(__dirname, "./process.js"), [], this.settings);
  }

  send(data) {
    return this.pool.scheduler.enqueue(null, data, this);
  }

  invoke(fn, data) {
    return this.pool.scheduler.enqueue(fn, data, this);
  }

  start(file) {
    registerHandlers(this);

    return this.invoke("__init", file).catch(error => {
      this.stop();
      this.process.emit("error", error);
    });
  }

  stop() {
    this.pool._removeWorker(this);
    this.state = States.stopped;

    if (this.process.connected) {
      this.process.disconnect();
    }
  }

  rejectQueue(error) {
    this.jobs
      .splice(0)
      .forEach(job => job.reject(error));
  }

  _do(job) {
    this.pending[job.message.id] = job;
    this.state = States.executing;
    this.process.send(job.message);
  }
}

function registerHandlers(worker) {
  worker.process
    .on("message", (message) => {
      if (worker.pending.hasOwnProperty(message.id)) {
        worker.state = worker.state === States.executing ? States.available : worker.state;
        handleResult(message, worker.pending[message.id]);
        delete worker.pending[message.id];
      }
      else if (message.type && typeof worker.pool._api[message.type] === "function") {
        if (message.id) {
          Promise.resolve(worker.pool._api[message.type](message.data))
            .then(data => worker.process.send({ id: message.id, data: data }))
            .catch(error => worker.process.send({ id: message.id, error: error }));
        }
        else {
          worker.pool._api[message.type](message.data);
        }
      }
      else if (!message.type && typeof worker.pool._api === "function") {
        if (message.id) {
          Promise.resolve(worker.pool._api(message.data))
            .then(data => worker.process.send({ id: message.id, data: data }))
            .catch(error => worker.process.send({ id: message.id, error: error }));
        }
        else {
          worker.pool._api(message.data);
        }
      }
      else {
        // TODO: handle messages with no handler
      }
    });
}

function handleResult(message, pending) {
  message.error ?
    pending.reject(message.error) :
    pending.resolve(message.data);
}

module.exports = Worker;
