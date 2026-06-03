import type { Action, ChatMessage } from './types';

const NEXT_QUESTION_TURN: ChatMessage = {
  role: 'user',
  content: 'Please ask the next interview question now.',
};

export function promptMessagesForAction(messages: ChatMessage[], action: Action): ChatMessage[] {
  if (action !== 'question') return messages;
  if (messages[messages.length - 1]?.role === 'user') return messages;
  return [...messages, NEXT_QUESTION_TURN];
}
