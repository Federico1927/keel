/** URL of a user's profile photo (versioned, so a new upload is a new URL); null without a photo. */
export function avatarUrl(user: { id: string; avatarVersion: number | null }): string | null {
  return user.avatarVersion ? `/avatar/${user.id}?v=${user.avatarVersion}` : null;
}
