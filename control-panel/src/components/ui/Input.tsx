'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

/* ── Field wrapper ──────────────────────────────────────────────────────── */

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={clsx('space-y-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-semibold uppercase tracking-widest text-white/55"
      >
        {label}
        {required ? <span className="ml-1 text-red-300">*</span> : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-white/40">{hint}</p>
      ) : null}
    </div>
  );
}

const BASE =
  'w-full rounded-xl px-3 py-2 text-sm text-white/90 glass-input placeholder:text-white/35 disabled:opacity-50';

/* ── Input ──────────────────────────────────────────────────────────────── */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  addon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, addon, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const input = (
    <div className="relative">
      <input
        id={inputId}
        ref={ref}
        className={clsx(BASE, addon && 'pr-24', error && 'border-red-400/60', className)}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {addon ? <div className="absolute right-1.5 top-1/2 -translate-y-1/2">{addon}</div> : null}
    </div>
  );
  if (!label) return input;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      {input}
    </Field>
  );
});

/* ── Textarea ───────────────────────────────────────────────────────────── */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const area = (
    <textarea
      id={inputId}
      ref={ref}
      className={clsx(BASE, 'scroll-slim resize-y leading-relaxed', error && 'border-red-400/60', className)}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  );
  if (!label) return area;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      {area}
    </Field>
  );
});

/* ── Select ─────────────────────────────────────────────────────────────── */

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
  error?: ReactNode;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const selectId = id ?? generated;
  const control = (
    <select
      id={selectId}
      ref={ref}
      className={clsx(
        BASE,
        'appearance-none bg-no-repeat pr-8',
        'bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 fill=%27none%27 viewBox=%270 0 24 24%27 stroke=%27currentColor%27 stroke-width=%272%27><path stroke-linecap=%27round%27 stroke-linejoin=%27round%27 d=%27M6 9l6 6 6-6%27/></svg>")] bg-[length:16px] bg-[right_0.6rem_center]',
        'dark:bg-slate-900',
        error && 'border-red-400/60',
        className,
      )}
      aria-invalid={error ? true : undefined}
      {...rest}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId}>
      {control}
    </Field>
  );
});

/* ── Toggle ─────────────────────────────────────────────────────────────── */

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  id?: string;
}

export function Toggle({ checked, onChange, label, hint, disabled, id }: ToggleProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <label htmlFor={inputId} className="text-sm text-white/80">
          {label}
        </label>
        {hint ? <p className="text-xs text-white/40">{hint}</p> : null}
      </div>
      <button
        id={inputId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative h-5 w-9 shrink-0 rounded-full border transition-all',
          checked
            ? 'border-blue-400/50 bg-blue-500/40 shadow-[0_0_14px_rgba(59,130,246,0.35)]'
            : 'border-white/15 bg-white/10',
          disabled && 'opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'absolute top-0.5 size-3.5 rounded-full bg-white/90 transition-all',
            checked ? 'left-[1.15rem]' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

/* ── Slider with a numeric input ────────────────────────────────────────── */

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: ReactNode;
  disabled?: boolean;
  format?: (value: number) => string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  disabled,
  format,
}: SliderProps) {
  const generated = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={generated}
          className="text-[11px] font-semibold uppercase tracking-widest text-white/55"
        >
          {label}
        </label>
        <span className="font-mono text-xs text-white/70">{format ? format(value) : value}</span>
      </div>
      <input
        id={generated}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-blue-400"
      />
      {hint ? <p className="text-xs text-white/40">{hint}</p> : null}
    </div>
  );
}

export { BASE as inputBaseClass };
