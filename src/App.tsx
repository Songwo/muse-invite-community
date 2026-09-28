import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, ArrowDownUp, ArrowRight, ArrowUpRight, AudioLines, Bell, Check, CheckCheck, CircleCheck, Clock3, Copy, ExternalLink, Gift, LayoutGrid, Link2, LoaderCircle, Menu, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Search, Send, ShieldCheck, Ticket, TicketCheck, Users, X } from 'lucide-react';
import type { Activity, Claim, CommunityState, Invitation, View } from '../shared/types';
import { FeedbackDialog, Modal, ProfileDialog, PublishDialog, ReviewDialog } from './components/Dialogs';
import { Avatar, InvitationCard } from './components/InvitationCard';
import { requestState, subscribeSessionChanges } from './lib/api';
import { activeClaim, claimLabels, filterInvitations, formatDate, invitationLabels, relativeTime } from './lib/presentation';
import type { InvitationFilter, InvitationSort } from './lib/presentation';

type Dialog = { type: 'publish' } | { type: 'profile' } | { type: 'detail'; id: string } | { type: 'feedback' | 'review'; id: string } | { type: 'confirm'; title: string; text: string; action: () => Promise<void> };
const viewTitles: Record<View, string> = { square: '邀请码广场', claims: '我的领取', shares: '我的分享', activity: '互助动态' };
const viewFromHash = (): View => {
  const value = window.location.hash.slice(1);
  return ['square', 'claims', 'shares', 'activity'].includes(value) ? value as View : 'square';
};

export default function App() {
  const [state, setState] = useState<CommunityState | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(viewFromHash);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InvitationFilter>('all');
  const [sort, setSort] = useState<InvitationSort>('newest');
  const [mobileMenu, setMobileMenu] = useState(false);
  const version = useRef(0);
  const busyRef = useRef(false);
  const inFlight = useRef<Promise<CommunityState> | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (busyRef.current) return;
    const current = ++version.current;
    if (!silent) setLoading(true);
    const request = inFlight.current ?? requestState();
    inFlight.current = request;
    try {
      const next = await request;
      if (version.current === current) { setState(next); setError(''); }
    } catch (reason) {
      if (version.current === current) {
        const message = reason instanceof Error ? reason.message : '连接失败，请重试。';
        if (!silent) setError(message);
      }
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (version.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(true); }, 20000);
    const navigate = () => { setView(viewFromHash()); setQuery(''); };
    const unsubscribeSession = subscribeSessionChanges(() => { inFlight.current = null; void refresh(true); });
    window.addEventListener('hashchange', navigate);
    return () => { window.clearInterval(timer); window.removeEventListener('hashchange', navigate); unsubscribeSession(); version.current++; };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function navigate(next: View) { window.location.hash = next; setView(next); setQuery(''); setMobileMenu(false); }
  function closeDialog() { if (!busyRef.current) setDialog(null); }

  async function mutate(path: string, body: unknown, message: string, method = 'POST'): Promise<CommunityState> {
    if (!state || busyRef.current) throw new Error('操作正在进行，请稍候。');
    busyRef.current = true; setBusy(true); setLoading(false); version.current++;
    inFlight.current = null;
    try {
      const next = await requestState(path, method, body, state.csrfToken);
      setState(next); setLoading(false); setError(''); setToast({ message });
      return next;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '操作未成功，请重试。';
      setToast({ message, error: true });
      throw new Error(message);
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function claimInvitation(invitation: Invitation) {
    try {
      await mutate(`/api/invitations/${invitation.id}/claim`, {}, '已领取邀请码');
      setDialog({ type: 'detail', id: invitation.id });
    } catch { void refresh(true); }
  }

  async function copyCode(content: string) {
    try { await navigator.clipboard.writeText(content); setToast({ message: '邀请码已复制' }); }
    catch { setToast({ message: '无法访问剪贴板，请选中邀请码手动复制。', error: true }); }
  }

  const myClaims = state?.claims.filter(claim => claim.claimantId === state.user.id) || [];
  const myShares = state?.invitations.filter(invitation => invitation.ownerId === state.user.id) || [];
  const waitingClaims = myClaims.filter(claim => ['reserved', 'submitted', 'invalid'].includes(claim.status));
  const reviewClaims = state?.claims.filter(claim => claim.invitation.ownerId === state.user.id && ['submitted', 'invalid'].includes(claim.status)) || [];
  const myConfirmed = myClaims.filter(claim => claim.status === 'confirmed').length;
  const shownInvitations = filterInvitations(view === 'shares' ? myShares : state?.invitations || [], { query, filter: view === 'shares' ? 'all' : filter, sort });
  const shownClaims = myClaims.filter(claim => [claim.invitation.ownerName, claim.invitation.note, claimLabels[claim.status]].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'ending' ? Date.parse(a.invitation.expiresAt) - Date.parse(b.invitation.expiresAt) : Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const detailInvitation = dialog?.type === 'detail' ? state?.invitations.find(invitation => invitation.id === dialog.id) : undefined;
  const currentClaim = dialog && (dialog.type === 'feedback' || dialog.type === 'review') ? state?.claims.find(claim => claim.id === dialog.id) : undefined;

  const navigation = <>
    <button className={`nav-item ${view === 'square' ? 'active' : ''}`} onClick={() => navigate('square')}><LayoutGrid size={19} /><span>邀请码广场</span></button>
    <button className={`nav-item ${view === 'claims' ? 'active' : ''}`} onClick={() => navigate('claims')}><TicketCheck size={19} /><span>我的领取</span>{myClaims.length > 0 && <span className="nav-count">{myClaims.length}</span>}</button>
    <button className={`nav-item ${view === 'shares' ? 'active' : ''}`} onClick={() => navigate('shares')}><Send size={19} /><span>我的分享</span>{reviewClaims.length > 0 && <span className="nav-count attention">{reviewClaims.length}</span>}</button>
    <div className="nav-divider" />
    <button className={`nav-item ${view === 'activity' ? 'active' : ''}`} onClick={() => navigate('activity')}><ActivityIcon size={19} /><span>互助动态</span></button>
  </>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
      <a className="brand" href="#square" aria-label="Muse 互助社区"><span className="brand-icon"><AudioLines size={23} /></span><span>muse<span className="brand-subtitle">互助社区</span></span></a>
      <span className="navigation-label">社区</span>
      <nav aria-label="主导航">{navigation}</nav>
      <div className="sidebar-bottom">
        <div className="muse-link"><img src={`${import.meta.env.BASE_URL}muse-avatar.png`} alt="Muse 头像" /><div><strong>Muse</strong><span>下一份邀请，下一位朋友</span></div></div>
        <a href="https://muse.ai" target="_blank" rel="noopener noreferrer" className="official-link">前往 Muse <ExternalLink size={14} /></a>
        <span className="community-disclaimer">独立互助社区 · 非官方网站</span>
      </div>
    </aside>
    {mobileMenu && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileMenu(false)} />}
    <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><button className="icon-button menu-toggle" title="打开导航" aria-label="打开导航" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={21} /></button><span>互助社区</span><span className="breadcrumb-slash">/</span><strong>{viewTitles[view]}</strong></div>
        <div className="topbar-actions"><span className="community-online"><span />Muse 邀请互助</span><button className="icon-button" title="刷新状态" aria-label="刷新状态" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw size={17} className={loading ? 'spinning' : ''} /></button><button className="top-user" onClick={() => state && setDialog({ type: 'profile' })} title="修改昵称" disabled={!state}><Avatar name={state?.user.name || '访客'} small /><span>{state?.user.name || '连接中'}</span></button></div>
      </header>
      <main>
        <div className="page-heading"><div><div className="page-kicker"><span />邀请，在这里相遇</div><h1>{view === 'square' ? 'Muse 邀请互助' : viewTitles[view]}</h1></div><button className="button primary publish-button" onClick={() => setDialog({ type: 'publish' })} disabled={!state || busy}><Plus size={18} />分享邀请码</button></div>
        <section className="community-stats" aria-label="社区统计">
          <div><span className="stat-icon sage"><Ticket size={21} /></span><div><span>可领取邀请</span><strong>{state?.stats.availableInvitations ?? 0}<small>份</small></strong></div></div>
          <div><span className="stat-icon blue"><Users size={21} /></span><div><span>剩余名额</span><strong>{state?.stats.remainingSlots ?? 0}<small>个</small></strong></div></div>
          <div><span className="stat-icon coral"><CheckCheck size={21} /></span><div><span>已确认互助</span><strong>{state?.stats.confirmedClaims ?? 0}<small>次</small></strong></div></div>
        </section>
        <div className="content-grid">
          <section className="primary-content" aria-label={viewTitles[view]}>
            <div className="section-heading"><h2>{viewTitles[view]}{state && <span>{view === 'claims' ? myClaims.length : view === 'shares' ? myShares.length : view === 'activity' ? state.activities.length : state.invitations.length}</span>}</h2>{view !== 'activity' && <label className="sort-control"><ArrowDownUp size={14} /><select aria-label="邀请排序" value={sort} onChange={event => setSort(event.target.value as InvitationSort)}><option value="newest">最新分享</option><option value="ending">即将到期</option></select></label>}</div>
            {view !== 'activity' && <div className="list-controls"><div className="search-field"><Search size={17} /><input aria-label="搜索邀请" placeholder={view === 'claims' ? '搜索我的领取' : '搜索昵称或留言'} value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14} /></button>}</div>{view === 'square' && <div className="filter-tabs" role="group" aria-label="邀请状态筛选">{([['all', '全部'], ['available', '可领取'], ['full', '已领满']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>}</div>}
            {error && <div className="connection-error" role="alert"><span>{error}</span><button className="button secondary compact" onClick={() => void refresh()}><RefreshCw size={14} />重试</button></div>}
            {!state ? loading ? <div className="loading-state" role="status"><LoaderCircle size={26} className="spinning" /><span>正在连接互助社区</span></div> : <EmptyState title="暂时无法连接社区" text="请检查连接后重试。" action={<button className="button secondary" onClick={() => void refresh()}><RefreshCw size={16} />重新连接</button>} /> : <>
              {(view === 'square' || view === 'shares') && (shownInvitations.length > 0 ? <div className="invitation-grid">{shownInvitations.map(invitation => <InvitationCard key={invitation.id} invitation={invitation} owned={invitation.ownerId === state.user.id} claimed={myClaims.some(claim => claim.invitationId === invitation.id && activeClaim(claim.status))} busy={busy} onOpen={() => setDialog({ type: 'detail', id: invitation.id })} onClaim={() => void claimInvitation(invitation)} />)}</div> : <EmptyState title={query || filter !== 'all' && view === 'square' ? '没有找到匹配的邀请' : view === 'shares' ? '你还没有分享邀请码' : '第一份邀请，正在等你'} text={query ? '没有符合当前搜索的分享。' : view === 'shares' ? '我的分享记录会保存在这里。' : '目前还没有人分享 Muse 邀请。'} action={query || filter !== 'all' && view === 'square' ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button> : <button className="button primary" onClick={() => setDialog({ type: 'publish' })}><Plus size={16} />{view === 'shares' ? '分享邀请码' : '分享第一份邀请'}</button>} />)}
              {view === 'claims' && (shownClaims.length > 0 ? <div className="claim-list">{shownClaims.map(claim => <ClaimItem key={claim.id} claim={claim} onOpen={() => setDialog({ type: 'detail', id: claim.invitationId })} onFeedback={() => setDialog({ type: 'feedback', id: claim.id })} />)}</div> : <EmptyState title={query ? '没有找到匹配的领取记录' : '你还没有领取邀请码'} text="暂无领取记录。" action={<button className="button secondary" onClick={() => navigate('square')}><LayoutGrid size={16} />前往邀请码广场</button>} />)}
              {view === 'activity' && (state.activities.length > 0 ? <ActivityList items={state.activities} onOpen={id => setDialog({ type: 'detail', id })} /> : <EmptyState title="还没有互助动态" text="社区等待第一份邀请。" action={<button className="button secondary" onClick={() => navigate('square')}><ArrowRight size={16} />回到广场</button>} />)}
            </>}
            <div className="list-bottom-note"><ShieldCheck size={14} /><span>领取状态来自用户反馈与分享者确认</span></div>
          </section>
          <aside className="right-column" aria-label="我的互助概览">
            <section className="personal-section"><div className="rail-title"><h2>我的互助</h2><button className="icon-button" title="修改昵称" aria-label="修改昵称" onClick={() => setDialog({ type: 'profile' })} disabled={!state}><Pencil size={15} /></button></div><div className="personal-identity"><Avatar name={state?.user.name || '访客'} /><div><strong>{state?.user.name || '访客'}</strong><span>社区成员</span></div></div><div className="personal-stats"><div><strong>{waitingClaims.length}</strong><span>进行中的领取</span></div><div><strong>{myConfirmed}</strong><span>已确认互助</span></div></div><button className="rail-link" onClick={() => navigate('claims')}>我的领取记录<ArrowRight size={15} /></button>{reviewClaims.length > 0 && <button className="review-notice" onClick={() => navigate('shares')}><Bell size={16} /><span>{reviewClaims.length} 条反馈等待你确认</span><ArrowRight size={14} /></button>}</section>
            <section className="recent-section"><div className="rail-title"><h2>最近动态</h2><span className="live-label"><span />动态</span></div>{state?.activities.length ? <ActivityList items={state.activities.slice(0, 4)} onOpen={id => setDialog({ type: 'detail', id })} compact /> : <div className="empty-activity"><ActivityIcon size={25} /><span>暂无互助动态</span></div>}<button className="rail-link" onClick={() => navigate('activity')}>全部动态<ArrowRight size={15} /></button></section>
            <section className="community-note"><span className="community-note-icon"><Gift size={21} /></span><h3>让邀请继续传递</h3><p>一份邀请，连接一个新的开始。</p><button className="text-action" onClick={() => setDialog({ type: 'publish' })} disabled={!state}>分享我的邀请<ArrowUpRight size={14} /></button></section>
          </aside>
        </div>
        <footer className="page-footer"><span>Muse 互助社区</span><span>非官方 · 不收取邀请码费用</span></footer>
      </main>
    </div>
    {dialog?.type === 'publish' && <PublishDialog onClose={closeDialog} onPublish={async input => { await mutate('/api/invitations', input, '邀请码已分享'); setDialog(null); navigate('shares'); }} />}
    {dialog?.type === 'profile' && state && <ProfileDialog name={state.user.name} onClose={closeDialog} onSave={async name => { await mutate('/api/profile', { name }, '昵称已更新', 'PATCH'); setDialog(null); }} />}
    {dialog?.type === 'feedback' && currentClaim && <FeedbackDialog claim={currentClaim} onClose={closeDialog} onSubmit={async (result, note) => { await mutate(`/api/claims/${currentClaim.id}/feedback`, { result, note }, '使用反馈已提交'); setDialog({ type: 'detail', id: currentClaim.invitationId }); }} />}
    {dialog?.type === 'review' && currentClaim && <ReviewDialog claim={currentClaim} onClose={closeDialog} onReview={async (decision, note) => { await mutate(`/api/claims/${currentClaim.id}/review`, { decision, note }, decision === 'confirm' ? '互助已确认' : '反馈已退回'); setDialog({ type: 'detail', id: currentClaim.invitationId }); }} />}
    {detailInvitation && state && <InviteDetails invitation={detailInvitation} state={state} busy={busy} onClose={closeDialog} onClaim={() => void claimInvitation(detailInvitation)} onCopy={content => void copyCode(content)} onFeedback={claim => setDialog({ type: 'feedback', id: claim.id })} onReview={claim => setDialog({ type: 'review', id: claim.id })} onCancel={claim => setDialog({ type: 'confirm', title: '取消这次领取？', text: '取消后将释放领取名额，当前记录会保留。', action: async () => { await mutate(`/api/claims/${claim.id}/cancel`, {}, '领取已取消'); setDialog(null); } })} onManage={action => { const execute = async () => { await mutate(`/api/invitations/${detailInvitation.id}`, { action }, action === 'pause' ? '分享已暂停' : action === 'resume' ? '分享已恢复' : '分享已结束', 'PATCH'); setDialog({ type: 'detail', id: detailInvitation.id }); }; if (action === 'close') setDialog({ type: 'confirm', title: '结束这份分享？', text: '结束后不再接受新领取，已有领取仍可以提交反馈。这份分享无法重新开放。', action: execute }); else void execute().catch(() => void refresh(true)); }} />}
    {dialog?.type === 'confirm' && <Modal title={dialog.title} onClose={closeDialog}><p className="confirm-text">{dialog.text}</p><div className="form-actions"><button className="button secondary" onClick={closeDialog} disabled={busy}>返回</button><button className="button danger" disabled={busy} onClick={() => void dialog.action().catch(() => void refresh(true))}>{busy ? <LoaderCircle size={16} className="spinning" /> : <Check size={16} />}确认</button></div></Modal>}
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status"><span>{toast.error ? <MessageSquare size={17} /> : <CircleCheck size={17} />}{toast.message}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={15} /></button></div>}
  </div>;
}

function EmptyState({ title, text, action }: { title: string; text: string; action: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-art"><span className="empty-art-ticket"><Ticket size={26} /></span><img src={`${import.meta.env.BASE_URL}muse-avatar.png`} alt="Muse" /><span className="empty-art-plus"><Plus size={16} /></span></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function ActivityList({ items, compact, onOpen }: { items: Activity[]; compact?: boolean; onOpen: (id: string) => void }) {
  return <div className={`activity-list ${compact ? 'compact' : ''}`}>{items.map(item => <button key={item.id} className="activity-item" onClick={() => onOpen(item.invitationId)}><span className={`activity-icon ${item.kind}`}>{item.kind === 'confirmed' ? <Check size={14} /> : item.kind === 'shared' ? <Gift size={14} /> : <Ticket size={14} />}</span><span className="activity-copy"><span><strong>{item.name}</strong>{item.kind === 'shared' ? ' 分享了邀请' : item.kind === 'claimed' ? ' 领取了邀请' : ' 确认了互助'}</span><time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time></span>{!compact && <ArrowUpRight size={15} />}</button>)}</div>;
}

function ClaimItem({ claim, onOpen, onFeedback }: { claim: Claim; onOpen: () => void; onFeedback: () => void }) {
  return <article className="claim-item"><div className="claim-heading"><div className="invite-person"><Avatar name={claim.invitation.ownerName} /><div><strong>{claim.invitation.ownerName} 的邀请</strong><span>{relativeTime(claim.createdAt)}领取</span></div></div><span className={`badge claim-${claim.status}`}>{claimLabels[claim.status]}</span></div><div className="claim-code"><Ticket size={17} /><span>{claim.invitation.preview}</span></div>{claim.feedbackNote && <p className="claim-note">我的反馈：{claim.feedbackNote}</p>}{claim.ownerNote && <p className="claim-note">分享者回复：{claim.ownerNote}</p>}<div className="claim-actions"><button className="button secondary compact" onClick={onOpen}>查看详情<ArrowUpRight size={14} /></button>{claim.status === 'reserved' && <button className="button primary compact" onClick={onFeedback}><MessageSquare size={14} />提交反馈</button>}</div></article>;
}

function InviteDetails({ invitation, state, busy, onClose, onCopy, onClaim, onFeedback, onReview, onCancel, onManage }: {
  invitation: Invitation; state: CommunityState; busy: boolean; onClose: () => void;
  onCopy: (content: string) => void; onClaim: () => void; onFeedback: (claim: Claim) => void;
  onReview: (claim: Claim) => void; onCancel: (claim: Claim) => void; onManage: (action: 'pause' | 'resume' | 'close') => void;
}) {
  const owned = invitation.ownerId === state.user.id;
  const allClaims = state.claims.filter(claim => claim.invitationId === invitation.id);
  const mine = allClaims.find(claim => claim.claimantId === state.user.id && activeClaim(claim.status));
  const latest = mine || allClaims.find(claim => claim.claimantId === state.user.id);
  return <Modal title={owned ? '我的邀请' : '邀请详情'} description={`由 ${invitation.ownerName} 分享`} onClose={onClose} wide>
    <div className="detail-top"><span className={`badge ${invitation.status}`}><span className="status-dot" />{invitationLabels[invitation.status]}</span><span>{formatDate(invitation.expiresAt)}到期</span></div>
    <div className="detail-code"><span className="field-label">Muse {invitation.kind === 'code' ? '邀请码' : '邀请链接'}</span><div><code>{invitation.content || invitation.preview}</code>{invitation.content && <button className="icon-button" title="复制邀请码" aria-label="复制邀请码" onClick={() => onCopy(invitation.content!)}><Copy size={18} /></button>}</div>{invitation.kind === 'link' && invitation.content && <a className="text-action" href={invitation.content} target="_blank" rel="noopener noreferrer">打开邀请链接<ExternalLink size={14} /></a>}</div>
    <div className="detail-note"><MessageSquare size={16} /><p>{invitation.note || '这位分享者没有留下备注。'}</p></div>
    <div className="detail-stats"><div><span>可领取名额</span><strong>{invitation.remaining} / {invitation.capacity}</strong></div><div><span>已确认互助</span><strong>{invitation.confirmedCount} 次</strong></div><div><span>分享日期</span><strong>{formatDate(invitation.createdAt)}</strong></div></div>
    {!owned && latest && <section className="claim-progress"><h3>我的领取状态<span className={`badge claim-${latest.status}`}>{claimLabels[latest.status]}</span></h3><div className="progress-steps"><span className="done"><Check size={14} />已领取</span><i /><span className={['submitted', 'invalid', 'confirmed'].includes(latest.status) ? 'done' : ''}><MessageSquare size={14} />使用反馈</span><i /><span className={latest.status === 'confirmed' ? 'done' : ''}><ShieldCheck size={14} />分享者确认</span></div>{latest.feedbackNote && <p>我的反馈：{latest.feedbackNote}</p>}{latest.ownerNote && <p>分享者回复：{latest.ownerNote}</p>}<div className="detail-claim-actions">{latest.status === 'reserved' && <button className="button primary" disabled={busy} onClick={() => onFeedback(latest)}><MessageSquare size={16} />提交反馈</button>}{['reserved', 'submitted', 'invalid'].includes(latest.status) && <button className="button secondary" disabled={busy} onClick={() => onCancel(latest)}>取消领取</button>}</div></section>}
    {owned && <section className="owner-claims"><h3>领取记录<span>{allClaims.length}</span></h3>{allClaims.length ? allClaims.map(claim => <div className="owner-claim-row" key={claim.id}><Avatar name={claim.claimantName} small /><div><strong>{claim.claimantName}</strong><span>{claimLabels[claim.status]}</span>{claim.feedbackNote && <p>{claim.feedbackNote}</p>}</div>{['submitted', 'invalid'].includes(claim.status) && <button className="button secondary compact" disabled={busy} onClick={() => onReview(claim)}>处理反馈<ArrowRight size={14} /></button>}</div>) : <p className="muted">暂时还没有人领取这份邀请。</p>}</section>}
    <div className="detail-footer">{owned ? <div className="form-actions">{!['closed', 'expired'].includes(invitation.status) && <button className="button secondary" disabled={busy} onClick={() => onManage(invitation.status === 'paused' ? 'resume' : 'pause')}>{invitation.status === 'paused' ? <Play size={16} /> : <Pause size={16} />}{invitation.status === 'paused' ? '恢复分享' : '暂停分享'}</button>}{invitation.status !== 'closed' && <button className="button danger-light" disabled={busy} onClick={() => onManage('close')}><X size={16} />结束分享</button>}</div> : !mine && <button className="button primary full-width" disabled={busy || invitation.status !== 'available'} onClick={onClaim}><Ticket size={17} />{invitation.status === 'available' ? '领取邀请码' : invitationLabels[invitation.status]}</button>}<p><ShieldCheck size={13} />状态来自站内反馈与分享者确认</p></div>
  </Modal>;
}
