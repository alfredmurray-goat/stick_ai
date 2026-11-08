import { createServer, type Server } from "node:net";
import { UserError } from "./platform.js";

export async function reservePort(first = 8080, last = 8099): Promise<{ port: number; release(): Promise<void> }> {
  for (let port = first; port <= last; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") { resolve(false); } else { reject(error); } });
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(true));
    });
    if (available) { return { port, release: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }; }
  }
  throw new UserError("busy");
}
export async function listenLocal(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { throw new UserError("busy"); }
  return address.port;
}
