"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { buttonClass } from "@/components/ui";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { cx } from "@/lib/cx";

type Field = "name" | "email" | "store" | "orders" | "message";
type Values = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;
type Status = "idle" | "sending" | "sent" | "error";

const ORDER_OPTIONS = ["lt1k", "1k5k", "5k20k", "gt20k"] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Posts to the configured webhook as JSON. The site is static, so the browser calls the webhook
 * directly (it must allow cross-origin POSTs). Without a webhook the submit opens a prefilled email.
 */
export function ContactForm({
  locale,
  webhookUrl,
  email,
}: {
  locale: LandingLocale;
  webhookUrl: string;
  email: string;
}) {
  const t = useTranslations("contact");
  const [values, setValues] = useState<Values>({
    name: "",
    email: "",
    store: "",
    orders: "",
    message: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [honeypot, setHoneypot] = useState("");

  function set(field: Field, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  }

  function validate(): Errors {
    const next: Errors = {};
    if (!values.name.trim()) next.name = t("required");
    if (!values.email.trim()) next.email = t("required");
    else if (!EMAIL_RE.test(values.email.trim())) next.email = t("invalid_email");
    if (!values.message.trim()) next.message = t("required");
    return next;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (honeypot) {
      setStatus("sent");
      return;
    }
    if (!webhookUrl) {
      const subject = `${PRODUCT_NAME} – ${values.name}`;
      const lines = [`${t("name")}: ${values.name}`, `${t("email")}: ${values.email}`];
      if (values.store) lines.push(`${t("store")}: ${values.store}`);
      if (values.orders)
        lines.push(
          `${t("orders")}: ${t(`orders_options.${values.orders as (typeof ORDER_OPTIONS)[number]}`)}`,
        );
      const body = [...lines, "", values.message].join("\n");
      window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      return;
    }
    setStatus("sending");
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          locale,
          source: "landing",
          submittedAt: new Date().toISOString(),
        }),
      });
      setStatus(res.ok ? "sent" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-success/40 bg-success/5 p-8" role="status">
        <p className="font-sans text-lg font-semibold">{t("success_title")}</p>
        <p className="mt-2 text-muted-foreground">{t("success_body")}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="rounded-2xl border border-border bg-card p-6 sm:p-8"
    >
      {!webhookUrl && <p className="mb-5 text-sm text-muted-foreground">{t("mailto_lead")}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id="name"
          label={t("name")}
          value={values.name}
          onChange={(v) => set("name", v)}
          error={errors.name}
          autoComplete="name"
          required
        />
        <Input
          id="email"
          type="email"
          label={t("email")}
          value={values.email}
          onChange={(v) => set("email", v)}
          error={errors.email}
          autoComplete="email"
          required
        />
        <Input
          id="store"
          type="url"
          label={t("store")}
          optional={t("optional")}
          value={values.store}
          onChange={(v) => set("store", v)}
          placeholder="https://"
          autoComplete="url"
        />
        <div>
          <Label htmlFor="orders">
            {t("orders")}{" "}
            <span className="font-normal text-muted-foreground">({t("optional")})</span>
          </Label>
          <select
            id="orders"
            value={values.orders}
            onChange={(e) => set("orders", e.target.value)}
            className={inputClass(false)}
          >
            <option value="">{t("orders_options.unset")}</option>
            {ORDER_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {t(`orders_options.${o}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-4">
        <Label htmlFor="message">{t("message")}</Label>
        <textarea
          id="message"
          rows={4}
          value={values.message}
          onChange={(e) => set("message", e.target.value)}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={errors.message ? "message-error" : undefined}
          className={cx(inputClass(Boolean(errors.message)), "h-auto min-h-28 py-2")}
          required
        />
        {errors.message && (
          <p id="message-error" className="mt-1 text-xs text-destructive">
            {errors.message}
          </p>
        )}
      </div>
      {/* Honeypot: hidden from people, filled by bots. */}
      <div
        className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
        aria-hidden="true"
      >
        <label htmlFor="company">Company</label>
        <input
          id="company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>
      {status === "error" && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {t("error", { email })}
        </p>
      )}
      <div className="mt-6">
        <button
          type="submit"
          className={buttonClass("primary", "lg")}
          disabled={status === "sending"}
        >
          {status === "sending" ? t("sending") : webhookUrl ? t("submit") : t("mailto_button")}
        </button>
      </div>
    </form>
  );
}

function inputClass(invalid: boolean) {
  return cx(
    "mt-1 block h-10 w-full rounded-md border bg-background px-3 text-sm placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    invalid ? "border-destructive" : "border-border",
  );
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {children}
    </label>
  );
}

function Input({
  id,
  label,
  optional,
  value,
  onChange,
  error,
  type = "text",
  placeholder,
  autoComplete,
  required,
}: {
  id: string;
  label: string;
  optional?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label htmlFor={id}>
        {label}{" "}
        {optional && <span className="font-normal text-muted-foreground">({optional})</span>}
      </Label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass(Boolean(error))}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
