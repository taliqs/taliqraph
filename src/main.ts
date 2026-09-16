import { EXIT } from './cli/exit-codes';
import { buildProgram } from './cli/program';

// `taliqraph … | head` closes the pipe early - that is not an error worth a stack trace.
process.stdout.on('error', (cause: NodeJS.ErrnoException) => {
  if (cause.code === 'EPIPE') {
    process.exit(EXIT.ok);
  }
  throw cause;
});

buildProgram()
  .parseAsync(process.argv)
  .then(() => {
    process.exit(process.exitCode ?? EXIT.ok);
  })
  .catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(EXIT.error);
  });
