'use strict';

/** An error that maps directly onto an HTTP response sent to the client. */
class HttpError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} code    stable machine-readable error code
   * @param {string} message human-readable message shown to the user
   * @param {Record<string,string>} [headers] extra response headers
   * @param {Record<string,unknown>} [details] extra fields for the JSON error body
   */
  constructor(status, code, message, headers = {}, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.details = details;
  }
}

module.exports = { HttpError };
