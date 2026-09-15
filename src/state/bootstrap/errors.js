export class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
  }
}
