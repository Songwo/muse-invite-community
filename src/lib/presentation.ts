import type { ClaimStatus, Invitation, InvitationStatus } from '../../shared/types';

export const invitationLabels: Record<InvitationStatus, string> = {
  available: '可领取', paused: '已暂停', closed: '已结束', expired: '已过期', full: '名额已满',
};

export const claimLabels: Record<ClaimStatus, string> = {
  reserved: '待使用反馈', submitted: '待分享者确认', confirmed: '互助已确认',
  invalid: '已反馈无效', cancelled: '已取消领取', rejected: '反馈已退回',
};

export type InvitationFilter = 'all' | 'available' | 'full';
export type InvitationSort = 'newest' | 'ending';

export function filterInvitations(items: Invitation[], options: { query: string; filter: InvitationFilter; sort: InvitationSort }): Invitation[] {
  const query = options.query.trim().toLocaleLowerCase();
  return items.filter(item => {
    const matchesQuery = !query || [item.ownerName, item.note, item.preview].join(' ').toLocaleLowerCase().includes(query);
    const matchesStatus = options.filter === 'all' || item.status === options.filter;
    return matchesQuery && matchesStatus;
  }).sort((a, b) => options.sort === 'ending'
    ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt)
    : Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function relativeTime(value: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} 天前`;
  return formatDate(value);
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

export function avatarColor(name: string): string {
  const colors = ['sage', 'blue', 'coral', 'violet'];
  return colors[Array.from(name).reduce((sum, letter) => sum + letter.codePointAt(0)!, 0) % colors.length];
}

export const activeClaim = (status: ClaimStatus) => !['cancelled', 'rejected'].includes(status);
