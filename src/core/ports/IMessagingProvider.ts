export interface IncomingMessage {
  from: string;
  body: string;
}

export interface IMessagingProvider {
  start(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<string>): void;
  send(to: string, text: string): Promise<void>;
}
