import * as React from "react";
import { useMemo, useState, type FormEvent } from "react";

import type { UserInputQuestion, UserInputRecord } from "../harness/contracts/user-input.js";
import {
  SecretRequestMetadataSchema,
  type SecretRequestMetadata,
} from "../harness/contracts/secrets.js";

export interface FlaryUserInputProps {
  record: UserInputRecord;
  onSubmit(
    requestId: string,
    answers: Readonly<Record<string, string>>,
    options?: { response?: string; canceled?: boolean },
  ): Promise<void> | void;
  className?: string;
  disabled?: boolean;
  otherLabel?: string;
  submitLabel?: string;
}

function initialAnswers(questions: UserInputQuestion[]) {
  return Object.fromEntries(questions.map((question) => [question.header, ""]));
}

/** Durable choice controls for the request_user_input agent tool. */
export function FlaryUserInput(props: FlaryUserInputProps) {
  const secureRequest = getSecretRequest(props.record);
  if (secureRequest) {
    return (
      <div
        className={`flary-user-input flary-secret-input-required ${props.className ?? ""}`.trim()}
        data-state={props.record.response ? "answered" : "waiting"}
      >
        <strong>{secureRequest.label}</strong>
        <p>Use the secure credential form. Do not paste this value into chat.</p>
      </div>
    );
  }
  return <FlaryRegularUserInput {...props} />;
}

function FlaryRegularUserInput({
  record,
  onSubmit,
  className = "",
  disabled = false,
  otherLabel = "Type another answer",
  submitLabel = "Continue",
}: FlaryUserInputProps) {
  const questions = record.request.questions;
  const seed = useMemo(() => initialAnswers(questions), [questions]);
  const [answers, setAnswers] = useState<Record<string, string>>(seed);
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const resolved = Boolean(record.response);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (resolved || disabled || submitting) return;
    const completed = Object.fromEntries(
      questions.map((question) => [
        question.header,
        other[question.header]?.trim() || answers[question.header] || "",
      ]),
    );
    if (Object.values(completed).some((answer) => !answer)) return;
    setSubmitting(true);
    try {
      await onSubmit(record.request.id, completed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={`flary-user-input ${className}`.trim()}
      data-state={resolved ? "answered" : "waiting"}
      onSubmit={submit}
    >
      {questions.map((question) => (
        <fieldset key={question.header} disabled={disabled || resolved || submitting}>
          <legend>
            <span>{question.header}</span>
            {question.question}
          </legend>
          <div className="flary-user-input__options">
            {question.options.map((option) => (
              <label key={option.label}>
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={question.header}
                  value={option.label}
                  checked={
                    question.multiSelect
                      ? (answers[question.header] ?? "").split(", ").includes(option.label)
                      : answers[question.header] === option.label && !other[question.header]
                  }
                  onChange={(event) => {
                    setOther((current) => ({
                      ...current,
                      [question.header]: "",
                    }));
                    setAnswers((current) => {
                      if (!question.multiSelect)
                        return { ...current, [question.header]: option.label };
                      const selected = new Set(
                        (current[question.header] ?? "").split(", ").filter(Boolean),
                      );
                      if (event.target.checked) selected.add(option.label);
                      else selected.delete(option.label);
                      return {
                        ...current,
                        [question.header]: [...selected].join(", "),
                      };
                    });
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            ))}
            <label className="flary-user-input__other">
              <span className="flary-user-input__other-label">
                {question.options.length > 0 ? otherLabel : "Your answer"}
              </span>
              <input
                type="text"
                value={other[question.header] ?? ""}
                onChange={(event) =>
                  setOther((current) => ({
                    ...current,
                    [question.header]: event.target.value,
                  }))
                }
                placeholder={question.options.length > 0 ? otherLabel : "Type your answer"}
              />
            </label>
          </div>
        </fieldset>
      ))}
      {!resolved && (
        <button type="submit" disabled={disabled || submitting}>
          {submitting ? "Sending…" : submitLabel}
        </button>
      )}
    </form>
  );
}

export interface FlarySecretInputProps {
  record: UserInputRecord;
  onSubmit(
    requestId: string,
    input: { value: string; description?: string; expiresAt?: string },
  ): Promise<void> | void;
  className?: string;
  disabled?: boolean;
  submitLabel?: string;
}

/** Protected credential control for the built-in request_secret tool. */
export function FlarySecretInput({
  record,
  onSubmit,
  className = "",
  disabled = false,
  submitLabel = "Store credential",
}: FlarySecretInputProps) {
  const request = getSecretRequest(record);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const resolved = Boolean(record.response);
  if (!request) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (resolved || disabled || submitting || !value) return;
    setSubmitting(true);
    try {
      await onSubmit(record.request.id, { value });
      setValue("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={`flary-secret-input ${className}`.trim()}
      data-state={resolved ? "stored" : "waiting"}
      onSubmit={submit}
      autoComplete="off"
    >
      <label>
        <strong>{request.label}</strong>
        <span>The agent cannot see this value.</span>
        <input
          type="password"
          name="credential"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={disabled || resolved || submitting}
          autoComplete="new-password"
          spellCheck={false}
        />
      </label>
      {request.docsUrl && (
        <a href={request.docsUrl} target="_blank" rel="noreferrer">
          Credential instructions
        </a>
      )}
      {!resolved && (
        <button type="submit" disabled={disabled || submitting || !value}>
          {submitting ? "Storing…" : submitLabel}
        </button>
      )}
    </form>
  );
}

export function getSecretRequest(record: UserInputRecord): SecretRequestMetadata | undefined {
  const parsed = SecretRequestMetadataSchema.safeParse(record.request.metadata?.flarySecretRequest);
  return parsed.success ? parsed.data : undefined;
}
