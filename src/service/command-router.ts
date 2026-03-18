import { resolveTelegramCommandHandler, type TelegramCommandHandlerKey } from "../telegram/commands.js";

export type BridgeCommandRouterHandlers = {
  [key in TelegramCommandHandlerKey]: () => Promise<void>;
};

export type BridgeCommandRouterActions = BridgeCommandRouterHandlers & {
  sendUnsupported(): Promise<void>;
};

export async function routeBridgeCommand(
  commandName: string,
  handlers: BridgeCommandRouterActions
): Promise<void> {
  const handler = resolveTelegramCommandHandler(commandName);
  if (!handler) {
    await handlers.sendUnsupported();
    return;
  }

  await handlers[handler]();
}
