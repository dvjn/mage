// The questions a call of the agent's puts to the thread, as a form: each question under its header
// chip with its options, one or several to pick, and Other to write an answer instead; an option's
// preview shows once it is picked. Answer sends them all, Skip lets the agent go on without; both
// are off for anyone who may not answer. What was answered shows in place afterwards, with who
// answered it.

import { type ReactNode, useId, useState } from "react";

import type { AskAnswers, AskInput, AskQuestion } from "@/shared/ask.ts";
import { MessageResponse } from "@/web/components/ai-elements/message";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Checkbox } from "@/web/components/ui/checkbox";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/web/components/ui/radio-group";

// What someone picked for one question so far: options by label, and their own words when Other
// is picked.
interface Choice {
  picked: string[];
  other: boolean;
  text: string;
}

const NONE: Choice = { picked: [], other: false, text: "" };

// The radio value of Other, which no option's label can be.
const OTHER = "\u0000other";

function answerOf(question: AskQuestion, choice: Choice): string | string[] | null {
  const own = choice.other ? choice.text.trim() : "";
  if (question.multiSelect) {
    const all = [...choice.picked, ...(own ? [own] : [])];
    return all.length > 0 ? all : null;
  }
  return choice.other ? own || null : (choice.picked[0] ?? null);
}

function QuestionField({
  question,
  choice,
  disabled,
  onChange,
}: {
  question: AskQuestion;
  choice: Choice;
  disabled: boolean;
  onChange: (choice: Choice) => void;
}) {
  const id = useId();
  const previews = question.options.filter(
    (option) => option.preview && choice.picked.includes(option.label),
  );
  const option = (label: string, description: string | undefined, control: ReactNode) => (
    <Label key={label} className="items-start gap-2 font-normal">
      {control}
      <span className="flex flex-col">
        {label}
        {description && <span className="text-xs text-muted-foreground">{description}</span>}
      </span>
    </Label>
  );
  const otherText = (
    <Input
      aria-label={`Other answer to ${question.header}`}
      placeholder="Other"
      disabled={disabled}
      value={choice.text}
      onFocus={() =>
        !choice.other &&
        onChange({ ...choice, other: true, picked: question.multiSelect ? choice.picked : [] })
      }
      onChange={(event) => onChange({ ...choice, text: event.target.value })}
      className="h-8"
    />
  );
  return (
    <fieldset className="flex flex-col gap-2" aria-labelledby={id}>
      <legend id={id} className="mb-2 flex items-start gap-2 text-sm font-medium">
        <Badge variant="outline" className="shrink-0">
          {question.header}
        </Badge>
        <span>{question.question}</span>
      </legend>
      {question.multiSelect ? (
        <div className="flex flex-col gap-2">
          {question.options.map((item) =>
            option(
              item.label,
              item.description,
              <Checkbox
                className="mt-0.5"
                disabled={disabled}
                checked={choice.picked.includes(item.label)}
                onCheckedChange={(on) =>
                  onChange({
                    ...choice,
                    picked: on
                      ? [...choice.picked, item.label]
                      : choice.picked.filter((label) => label !== item.label),
                  })
                }
              />,
            ),
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label="Other"
              disabled={disabled}
              checked={choice.other}
              onCheckedChange={(on) => onChange({ ...choice, other: on })}
            />
            {otherText}
          </div>
        </div>
      ) : (
        <RadioGroup
          aria-labelledby={id}
          disabled={disabled}
          value={choice.other ? OTHER : (choice.picked[0] ?? null)}
          onValueChange={(value) =>
            onChange(
              value === OTHER
                ? { ...choice, other: true, picked: [] }
                : { ...choice, other: false, picked: [value as string] },
            )
          }
        >
          {question.options.map((item) =>
            option(
              item.label,
              item.description,
              <RadioGroupItem value={item.label} className="mt-0.5" />,
            ),
          )}
          <div className="flex items-center gap-2">
            <RadioGroupItem value={OTHER} aria-label="Other" />
            {otherText}
          </div>
        </RadioGroup>
      )}
      {previews.map((item) => (
        <div
          key={item.label}
          className="rounded-md bg-muted px-3 py-2 text-xs"
          aria-label={`Preview of ${item.label}`}
        >
          <MessageResponse>{item.preview}</MessageResponse>
        </div>
      ))}
    </fieldset>
  );
}

export function QuestionForm({
  input,
  answer,
}: {
  input: AskInput;
  // Absent for anyone who may not answer.
  answer?: (answers: AskAnswers | null) => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [sending, setSending] = useState(false);
  const answers = input.questions.map((question) => [
    question.question,
    answerOf(question, choices[question.question] ?? NONE),
  ]);
  const complete = answers.every(([, value]) => value !== null);
  function send(value: AskAnswers | null) {
    if (!answer) return;
    setSending(true);
    void answer(value).finally(() => setSending(false));
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) send(Object.fromEntries(answers) as AskAnswers);
      }}
    >
      {input.questions.map((question) => (
        <QuestionField
          key={question.question}
          question={question}
          choice={choices[question.question] ?? NONE}
          disabled={!answer || sending}
          onChange={(choice) =>
            setChoices((current) => ({ ...current, [question.question]: choice }))
          }
        />
      ))}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" size="sm" disabled={!answer || !complete || sending}>
          Answer
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!answer || sending}
          onClick={() => send(null)}
        >
          Skip
        </Button>
      </div>
    </form>
  );
}

// What was answered, question by question under their header chips.
export function GivenAnswers({ input, answers }: { input: AskInput; answers: AskAnswers }) {
  return (
    <dl aria-label="Answers" className="flex flex-col gap-1 text-sm">
      {input.questions.map((question) => {
        const value = answers[question.question];
        if (value === undefined) return null;
        return (
          <div key={question.question} className="flex items-baseline gap-2">
            <dt className="shrink-0">
              <Badge variant="outline">{question.header}</Badge>
            </dt>
            <dd className="min-w-0">{Array.isArray(value) ? value.join(", ") : value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
