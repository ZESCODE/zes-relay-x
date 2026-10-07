/** Human-readable signal names used in lifecycle messages. */
export function signalName(signal: NodeJS.Signals | string): string {
  switch (signal) {
    case 'SIGTERM':
      return 'SIGTERM (graceful)';
    case 'SIGKILL':
      return 'SIGKILL (forced)';
    case 'SIGINT':
      return 'SIGINT (interrupt)';
    case 'SIGHUP':
      return 'SIGHUP (hangup)';
    case 'SIGSEGV':
      return 'SIGSEGV (segmentation fault)';
    case 'SIGABRT':
      return 'SIGABRT (abort)';
    default:
      return String(signal);
  }
}
