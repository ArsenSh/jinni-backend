// services/requestContext.js
//
// Per-request context carried through the async call chain WITHOUT threading
// parameters through every function signature. The auth middleware stores the
// authenticated userId here; deep call sites (googleService.trackApiCall) read
// it to attribute costs to the user who triggered them. AsyncLocalStorage
// keeps each request's store isolated under concurrency.

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

module.exports = {
    als,
    // Current request's store, or {} outside any request (cron, startup).
    get: () => als.getStore() || {},
};
