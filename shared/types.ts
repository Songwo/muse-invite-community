export type InvitationKind = 'code' | 'link';
export type InvitationStatus = 'available' | 'paused' | 'closed' | 'expired' | 'full';
export type ClaimStatus = 'reserved' | 'submitted' | 'confirmed' | 'invalid' | 'cancelled' | 'rejected';

export interface User {
  id: string;
  name: string;
  createdAt: string;
}

export interface Invitation {
  id: string;
  ownerId: string;
  ownerName: string;
  kind: InvitationKind;
  preview: string;
  content?: string;
  note: string;
  capacity: number;
  remaining: number;
  confirmedCount: number;
  pendingCount: number;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface Claim {
  id: string;
  invitationId: string;
  claimantId: string;
  claimantName: string;
  status: ClaimStatus;
  feedbackNote: string;
  ownerNote: string;
  createdAt: string;
  updatedAt: string;
  invitation: Invitation;
}

export interface Activity {
  id: string;
  kind: 'shared' | 'claimed' | 'confirmed';
  name: string;
  invitationId: string;
  createdAt: string;
}

export interface CommunityState {
  user: User;
  csrfToken: string;
  invitations: Invitation[];
  claims: Claim[];
  activities: Activity[];
  stats: {
    availableInvitations: number;
    remainingSlots: number;
    confirmedClaims: number;
    members: number;
  };
}

export interface PublishInput {
  kind: InvitationKind;
  content: string;
  note: string;
  capacity: number;
  expiresInDays: number;
}

export type View = 'square' | 'claims' | 'shares' | 'activity';
