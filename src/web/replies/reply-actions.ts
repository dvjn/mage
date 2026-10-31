// What a click in a reply's layout may do: post a message as the person who clicked, for anyone
// who may post in the thread.

import { createContext } from "react";

export const ReplyActions = createContext<{ send?: (text: string) => void }>({});
