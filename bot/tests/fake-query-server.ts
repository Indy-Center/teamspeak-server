import { createServer, type Server, type Socket } from 'node:net';

/**
 * Answers one raw ServerQuery command with the lines to send back, ending in an `error` line. `args`
 * holds its `key=value` parameters, unescaped, and `positional` the rest (`login <user> <password>`).
 */
export type Answer = (command: string, args: Record<string, string>, positional: string[]) => string[];

const OK = 'error id=0 msg=ok';

/**
 * A raw ServerQuery server on a local port, speaking just enough of TeamSpeak's line protocol for
 * ts3-nodejs-library to connect, log in and run commands against it.
 */
export class FakeQueryServer {
  readonly commands: string[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly answer: Answer) {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.setEncoding('utf8');
      socket.write('TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface.\n\r');
      let buffered = '';
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines.map((line) => line.trim()).filter(Boolean)) this.handle(socket, line);
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return address.port;
  }

  /** Closes every open connection from the server's side. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket, line: string): void {
    this.commands.push(line);
    const [name = '', ...rest] = line.split(' ');
    const args = Object.fromEntries(
      rest.filter((part) => part.includes('=')).map((part) => {
        const at = part.indexOf('=');
        return [part.slice(0, at), unescape(part.slice(at + 1))];
      }),
    );
    const positional = rest.filter((part) => !part.includes('=')).map(unescape);
    let reply: string[];
    switch (name) {
      case 'version':
        reply = ['version=3.13.8 build=1 platform=Linux', OK];
        break;
      case 'quit':
        socket.end(`${OK}\n\r`);
        return;
      default:
        reply = this.answer(name, args, positional);
    }
    socket.write(reply.map((reply) => `${reply}\n\r`).join(''));
  }
}

function unescape(value: string): string {
  return value.replace(/\\s/g, ' ').replace(/\\\//g, '/').replace(/\\p/g, '|').replace(/\\\\/g, '\\');
}

export { OK };
