declare module "ws" {
  type RawData = Buffer | ArrayBuffer | Buffer[];

  class WebSocket {
    public static readonly OPEN: number;
    public static readonly CLOSED: number;
    public readonly readyState: number;
    public constructor(address: string);
    public on(event: string, listener: (...args: never[]) => void): this;
    public once(event: string, listener: (...args: never[]) => void): this;
    public send(data: string): void;
    public close(): void;
    public terminate(): void;
  }

  export { RawData };
  export default WebSocket;
}
