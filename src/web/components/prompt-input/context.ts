// What the prompt input's parts share: its text, its attachments and the sources it refers to.

import type { FileUIPart, SourceDocumentUIPart } from "ai";
import type { RefObject } from "react";
import { createContext, useContext } from "react";

export interface AttachmentsContext {
  files: (FileUIPart & { id: string })[];
  add: (files: File[] | FileList) => void;
  remove: (id: string) => void;
  clear: () => void;
  openFileDialog: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

interface TextInputContext {
  value: string;
  setInput: (v: string) => void;
  clear: () => void;
}

interface PromptInputControllerProps {
  textInput: TextInputContext;
  attachments: AttachmentsContext;
  /** INTERNAL: Allows PromptInput to register its file textInput + "open" callback */
  __registerFileInput: (ref: RefObject<HTMLInputElement | null>, open: () => void) => void;
}

const PromptInputController = createContext<PromptInputControllerProps | null>(null);

const ProviderAttachmentsContext = createContext<AttachmentsContext | null>(null);

// Optional variants (do NOT throw). Useful for dual-mode components.
export const useOptionalPromptInputController = () => useContext(PromptInputController);

const useOptionalProviderAttachments = () => useContext(ProviderAttachmentsContext);

export const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
  // Prefer local context (inside PromptInput) as it has validation, fall back to provider
  const provider = useOptionalProviderAttachments();
  const local = useContext(LocalAttachmentsContext);
  const context = local ?? provider;
  if (!context) {
    throw new Error(
      "usePromptInputAttachments must be used within a PromptInput or PromptInputProvider",
    );
  }
  return context;
};

export interface ReferencedSourcesContext {
  sources: (SourceDocumentUIPart & { id: string })[];
  add: (sources: SourceDocumentUIPart[] | SourceDocumentUIPart) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const LocalReferencedSourcesContext = createContext<ReferencedSourcesContext | null>(null);
