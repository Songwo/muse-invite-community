import { ArrowUpRight, Clock3, Link2, Ticket, Users } from 'lucide-react';
import type { Invitation } from '../../shared/types';
import { avatarColor, formatDate, invitationLabels, relativeTime } from '../lib/presentation';

export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return <span aria-hidden="true" className={`avatar ${avatarColor(name)} ${small ? 'small' : ''}`}>{Array.from(name)[0]}</span>;
}

export function InvitationCard({ invitation, owned, claimed, busy, onOpen, onClaim }: {
  invitation: Invitation; owned: boolean; claimed: boolean; busy: boolean;
  onOpen: () => void; onClaim: () => void;
}) {
  const available = invitation.status === 'available';
  return <article className="invitation-card">
    <div className="invite-person-row">
      <div className="invite-person"><Avatar name={invitation.ownerName} /><div><strong>{invitation.ownerName}</strong><span>{relativeTime(invitation.createdAt)}分享{owned ? ' · 我的分享' : ''}</span></div></div>
      <span className={`badge ${invitation.status}`}><span className="status-dot" />{invitationLabels[invitation.status]}</span>
    </div>
    <button className="invite-code-line" onClick={onOpen} aria-label={`查看 ${invitation.ownerName} 的邀请`}>
      <span className="ticket-symbol">{invitation.kind === 'code' ? <Ticket size={22} /> : <Link2 size={22} />}</span>
      <div><span className="code-label">Muse {invitation.kind === 'code' ? '邀请码' : '邀请链接'}</span><span className="masked-code">{invitation.preview}</span></div>
      <ArrowUpRight size={17} />
    </button>
    <p className="invite-note">{invitation.note || '分享一份 Muse 邀请。'}</p>
    <div className="invite-meta"><span><Users size={14} />剩余 <b>{invitation.remaining}</b> / {invitation.capacity} 个名额</span><span><Clock3 size={14} />{formatDate(invitation.expiresAt)}到期</span></div>
    <div className="invite-card-footer">
      <span className="confirmed-mini">{invitation.confirmedCount > 0 ? `${invitation.confirmedCount} 次互助已确认` : '等待第一份互助'}</span>
      <button className={`button compact ${available && !owned && !claimed ? 'primary' : 'secondary'}`} disabled={busy || (!owned && !claimed && !available)} onClick={owned || claimed ? onOpen : onClaim}>
        {owned ? '管理分享' : claimed ? '查看领取' : available ? '领取邀请码' : invitationLabels[invitation.status]}
        {(available || owned || claimed) && <ArrowUpRight size={15} />}
      </button>
    </div>
  </article>;
}
