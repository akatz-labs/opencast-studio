// Node children receive a private IPC channel from their desktop supervisor.
// Losing it terminates only this app UI/API process, not executor-owned work.
if (process.send) process.once('disconnect', () => {
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(1), 10000).unref();
});
