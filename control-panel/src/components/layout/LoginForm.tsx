'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ApiClientError, login } from '@/lib/api';
import { useToast } from '@/lib/hooks/useToast';

export interface LoginFormProps {
  nextPath?: string;
}

export function LoginForm({ nextPath = '/dashboard' }: LoginFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const me = await login(username.trim(), password);
      toast.success('Signed in', `Welcome back, ${me.user?.username ?? username}`);
      router.replace(nextPath);
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ApiClientError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'Sign in failed';
      setError(message);
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="glass-card space-y-4 rounded-2xl p-6" noValidate>
      <Input
        label="Username"
        name="username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        autoFocus
        required
      />
      <Input
        label="Password"
        name="password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete="current-password"
        required
        error={error ?? undefined}
      />
      <Button type="submit" variant="frost" fullWidth loading={pending} disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-[11px] leading-relaxed text-white/35">
        Sessions are signed httpOnly cookies (SameSite=Lax, Secure over HTTPS). Failed attempts are rate
        limited to 5 per minute per IP.
      </p>
    </form>
  );
}

export default LoginForm;
