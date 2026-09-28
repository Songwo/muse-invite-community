import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, Link, LoaderCircle, Send, Undo2, UserRound, X } from 'lucide-react';
import type { Claim, InvitationKind, PublishInput } from '../../shared/types';

type ModalProps = {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
};

const focusableSelector =
  'button, a[href], input:not([type="hidden"]), textarea, select, [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.matches(':disabled') && element.getClientRects().length > 0,
  );
}

export function Modal({ title, description, onClose, children, wide = false }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const formControl = panel.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)',
    );
    (formControl ?? focusableElements(panel)[0] ?? panel).focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements(panel);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const active = document.activeElement;
      if (!panel.contains(active) || active === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target)) {
        (focusableElements(panel)[0] ?? panel).focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', handleFocus);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', handleFocus);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? ' wide' : ''}`}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <h2 className="modal-title" id={titleId}>{title}</h2>
            {description && <p className="modal-description" id={descriptionId}>{description}</p>}
          </div>
          <button type="button" className="modal-close icon-button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function useAsyncForm(onClose: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef(false);

  const submit = async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '操作失败，请稍后重试。');
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return {
    pending,
    error,
    setError,
    submit,
    close: () => { if (!pendingRef.current) onClose(); },
  };
}

function FormError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{message}</p>;
}

function SubmitIcon({ pending, children }: { pending: boolean; children: ReactNode }) {
  return pending ? <LoaderCircle className="pending-icon" size={17} aria-hidden="true" /> : children;
}

function validInvitationLink(value: string) {
  try {
    const link = new URL(value);
    return link.protocol === 'https:' &&
      (link.hostname === 'muse.ai' || link.hostname.endsWith('.muse.ai')) &&
      !link.username && !link.password && (!link.port || link.port === '443');
  } catch {
    return false;
  }
}

export function PublishDialog({ onClose, onPublish }: {
  onClose: () => void;
  onPublish: (input: PublishInput) => Promise<void>;
}) {
  const id = useId();
  const [kind, setKind] = useState<InvitationKind>('code');
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [capacity, setCapacity] = useState('1');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [confirmed, setConfirmed] = useState(false);
  const form = useAsyncForm(onClose);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.pending) return;
    const value = content.trim();
    const slots = Number(capacity);
    if (!value) return form.setError(kind === 'code' ? '请填写邀请码。' : '请填写邀请链接。');
    if (kind === 'code' && (value.length < 4 || value.length > 120)) {
      return form.setError('邀请码长度需为 4 至 120 个字符。');
    }
    if (kind === 'link' && !validInvitationLink(value)) {
      return form.setError('邀请链接需为 muse.ai 或其子域名的 HTTPS 链接，且不得包含账号密码或非默认端口。');
    }
    if (note.trim().length > 160) return form.setError('备注最多 160 个字符。');
    if (!Number.isInteger(slots) || slots < 1 || slots > 20) return form.setError('可邀请名额需为 1 至 20 的整数。');
    const days = Number(expiresInDays);
    if (![1, 3, 7, 14, 30].includes(days)) return form.setError('请选择有效期。');
    if (!confirmed) return form.setError('请确认已核对可邀请名额。');
    void form.submit(() => onPublish({ kind, content: value, note: note.trim(), capacity: slots, expiresInDays: days }));
  };

  return (
    <Modal title="分享邀请码" onClose={form.close}>
      <form className="form-stack" onSubmit={handleSubmit} noValidate aria-busy={form.pending}>
        <div className="form-field">
          <span className="field-label" id={`${id}-kind`}>邀请类型</span>
          <div className="segmented" role="group" aria-labelledby={`${id}-kind`}>
            <button type="button" className={kind === 'code' ? 'active' : ''} aria-pressed={kind === 'code'} disabled={form.pending} onClick={() => setKind('code')}>邀请码</button>
            <button type="button" className={kind === 'link' ? 'active' : ''} aria-pressed={kind === 'link'} disabled={form.pending} onClick={() => setKind('link')}><Link size={15} aria-hidden="true" />邀请链接</button>
          </div>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${id}-content`}>{kind === 'code' ? '邀请码' : '邀请链接'}</label>
          <input
            id={`${id}-content`}
            name="content"
            type={kind === 'link' ? 'url' : 'text'}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            minLength={kind === 'code' ? 4 : undefined}
            maxLength={kind === 'code' ? 120 : 2048}
            required
            disabled={form.pending}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-content-hint`}
          />
          <span className="field-hint" id={`${id}-content-hint`}>{kind === 'code' ? '4 至 120 个字符' : '仅限 muse.ai 的 HTTPS 链接'}</span>
        </div>
        <div className="form-row">
          <div className="form-field">
            <label className="field-label" htmlFor={`${id}-capacity`}>可邀请名额</label>
            <input id={`${id}-capacity`} name="capacity" type="number" min={1} max={20} step={1} value={capacity} onChange={(event) => setCapacity(event.target.value)} required disabled={form.pending} aria-describedby={`${id}-capacity-hint`} />
            <span className="field-hint" id={`${id}-capacity-hint`}>1 至 20 个</span>
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor={`${id}-expiry`}>有效期</label>
            <select id={`${id}-expiry`} name="expiresInDays" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} disabled={form.pending}>
              {[1, 3, 7, 14, 30].map((days) => <option key={days} value={days}>{days} 天</option>)}
            </select>
          </div>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${id}-note`}>备注 <span className="field-hint">选填</span></label>
          <textarea id={`${id}-note`} name="note" rows={3} maxLength={160} value={note} onChange={(event) => setNote(event.target.value)} disabled={form.pending} />
          <span className="field-hint">{note.length}/160</span>
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required disabled={form.pending} />
          <span>我已核对可邀请名额</span>
        </label>
        <FormError message={form.error} />
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={form.close} disabled={form.pending}><X size={16} aria-hidden="true" />取消</button>
          <button className="button primary" type="submit" disabled={form.pending}><SubmitIcon pending={form.pending}><Send size={16} aria-hidden="true" /></SubmitIcon>{form.pending ? '分享中' : '分享邀请码'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProfileDialog({ name, onClose, onSave }: {
  name: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(name);
  const form = useAsyncForm(onClose);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.pending) return;
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 16) return form.setError('昵称长度需为 2 至 16 个字符。');
    void form.submit(() => onSave(trimmed));
  };

  return (
    <Modal title="修改昵称" onClose={form.close}>
      <form className="form-stack" onSubmit={handleSubmit} noValidate aria-busy={form.pending}>
        <div className="form-field">
          <label className="field-label" htmlFor={`${id}-name`}>昵称</label>
          <input id={`${id}-name`} name="name" value={value} onChange={(event) => setValue(event.target.value)} minLength={2} maxLength={16} required disabled={form.pending} autoComplete="nickname" aria-describedby={`${id}-name-hint`} />
          <span className="field-hint" id={`${id}-name-hint`}>2 至 16 个字符</span>
        </div>
        <FormError message={form.error} />
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={form.close} disabled={form.pending}><X size={16} aria-hidden="true" />取消</button>
          <button type="submit" className="button primary" disabled={form.pending}><SubmitIcon pending={form.pending}><UserRound size={16} aria-hidden="true" /></SubmitIcon>{form.pending ? '保存中' : '保存昵称'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function FeedbackDialog({ claim, onClose, onSubmit }: {
  claim: Claim;
  onClose: () => void;
  onSubmit: (result: 'submitted' | 'invalid', note: string) => Promise<void>;
}) {
  const id = useId();
  const [result, setResult] = useState<'submitted' | 'invalid'>(claim.status === 'invalid' ? 'invalid' : 'submitted');
  const [note, setNote] = useState(claim.feedbackNote);
  const form = useAsyncForm(onClose);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.pending) return;
    const trimmed = note.trim();
    if (trimmed.length > 240) return form.setError('备注最多 240 个字符。');
    if (result === 'invalid' && !trimmed) return form.setError('请填写邀请码无法使用的原因。');
    void form.submit(() => onSubmit(result, trimmed));
  };

  return (
    <Modal title="反馈领取结果" description={`来自 ${claim.invitation.ownerName} 的邀请`} onClose={form.close}>
      <form className="form-stack" onSubmit={handleSubmit} noValidate aria-busy={form.pending}>
        <div className="form-field">
          <span className="field-label" id={`${id}-result-label`}>当前结果</span>
          <div className="choice-list" role="radiogroup" aria-labelledby={`${id}-result-label`}>
            <label className={`choice-option${result === 'submitted' ? ' selected' : ''}`}>
              <input type="radio" name={`${id}-result`} value="submitted" checked={result === 'submitted'} onChange={() => setResult('submitted')} disabled={form.pending} />
              <span>已使用，等待确认</span>
            </label>
            <label className={`choice-option${result === 'invalid' ? ' selected' : ''}`}>
              <input type="radio" name={`${id}-result`} value="invalid" checked={result === 'invalid'} onChange={() => setResult('invalid')} disabled={form.pending} />
              <span>邀请码无法使用</span>
            </label>
          </div>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${id}-note`}>{result === 'invalid' ? '无法使用的原因' : '备注'} {result === 'submitted' && <span className="field-hint">选填</span>}</label>
          <textarea id={`${id}-note`} name="note" rows={3} maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} required={result === 'invalid'} disabled={form.pending} />
          <span className="field-hint">{note.length}/240</span>
        </div>
        <FormError message={form.error} />
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={form.close} disabled={form.pending}><X size={16} aria-hidden="true" />取消</button>
          <button type="submit" className="button primary" disabled={form.pending}><SubmitIcon pending={form.pending}><Send size={16} aria-hidden="true" /></SubmitIcon>{form.pending ? '保存中' : '保存反馈'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ReviewDialog({ claim, onClose, onReview }: {
  claim: Claim;
  onClose: () => void;
  onReview: (decision: 'confirm' | 'reject', note: string) => Promise<void>;
}) {
  const id = useId();
  const [decision, setDecision] = useState<'confirm' | 'reject'>(claim.status === 'invalid' ? 'reject' : 'confirm');
  const [note, setNote] = useState('');
  const form = useAsyncForm(onClose);
  const canConfirm = claim.status === 'submitted';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form.pending) return;
    const trimmed = note.trim();
    if (!['submitted', 'invalid'].includes(claim.status)) return form.setError('当前反馈已处理，请刷新列表。');
    if (decision === 'confirm' && !canConfirm) return form.setError('无法使用的邀请不能确认互助。');
    if (trimmed.length > 240) return form.setError('备注最多 240 个字符。');
    if (decision === 'reject' && !trimmed) return form.setError('请填写退回反馈的原因。');
    void form.submit(() => onReview(decision, trimmed));
  };

  return (
    <Modal title="处理领取反馈" onClose={form.close}>
      <form className="form-stack" onSubmit={handleSubmit} noValidate aria-busy={form.pending}>
        <div className="review-person">
          <UserRound size={20} aria-hidden="true" />
          <div><strong>{claim.claimantName}</strong><p>{claim.status === 'submitted' ? '已使用，等待确认' : claim.status === 'invalid' ? '邀请码无法使用' : '反馈已处理'}</p></div>
        </div>
        {claim.feedbackNote && <p className="feedback-summary">{claim.feedbackNote}</p>}
        <div className="form-field">
          <span className="field-label" id={`${id}-decision-label`}>处理结果</span>
          <div className="choice-list" role="radiogroup" aria-labelledby={`${id}-decision-label`}>
            {canConfirm && <label className={`choice-option${decision === 'confirm' ? ' selected' : ''}`}>
              <input type="radio" name={`${id}-decision`} value="confirm" checked={decision === 'confirm'} onChange={() => setDecision('confirm')} disabled={form.pending} />
              <span>确认互助成功</span>
            </label>}
            <label className={`choice-option${decision === 'reject' ? ' selected' : ''}`}>
              <input type="radio" name={`${id}-decision`} value="reject" checked={decision === 'reject'} onChange={() => setDecision('reject')} disabled={form.pending} />
              <span>退回反馈</span>
            </label>
          </div>
        </div>
        <div className="form-field">
          <label className="field-label" htmlFor={`${id}-note`}>{decision === 'reject' ? '退回原因' : '备注'} {decision === 'confirm' && <span className="field-hint">选填</span>}</label>
          <textarea id={`${id}-note`} name="note" rows={3} maxLength={240} value={note} onChange={(event) => setNote(event.target.value)} required={decision === 'reject'} disabled={form.pending} />
          <span className="field-hint">{note.length}/240</span>
        </div>
        <FormError message={form.error} />
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={form.close} disabled={form.pending}><X size={16} aria-hidden="true" />取消</button>
          <button type="submit" className={`button ${decision === 'reject' ? 'danger' : 'primary'}`} disabled={form.pending}>
            <SubmitIcon pending={form.pending}>{decision === 'reject' ? <Undo2 size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}</SubmitIcon>
            {form.pending ? '保存中' : decision === 'reject' ? '退回反馈' : '确认互助'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
