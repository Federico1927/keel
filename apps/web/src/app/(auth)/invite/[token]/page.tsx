import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { adminDb } from "@hullwise/db";
import { findInvitationByToken } from "@hullwise/services";
import { Button } from "@hullwise/ui";
import { AuthShell } from "@/components/account/auth-shell";
import { getCurrentUser } from "@/server/session";
import { AcceptAsUserButton, AcceptInvitationForm, SignOutAndReturnButton } from "./forms";

import { withIntl } from "@/i18n/intl-scope";
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("account"))("invite_title") };
}

/**
 * Accept page of an invitation (#52). A new person sets name, password (or email links) and accepts
 * the privacy policy; an existing account signs in first, then joins. Expired, revoked, used or
 * unknown tokens get a clear page. Opening the page changes nothing: acceptance is a POST.
 */
async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await params;
  const token = rawToken.slice(0, 200);
  const t = await getTranslations("account");
  const tr = await getTranslations("roles");
  const inv = await findInvitationByToken(adminDb(), token);
  if (!inv || inv.state !== "pending") {
    const state = inv?.state ?? "invalid";
    return (
      <AuthShell title={t(`invite_${state}_title`)} description={t(`invite_${state}_description`, { tenant: inv?.tenantName ?? "" })} testId="invite-unusable">
        <p className="text-sm text-muted-foreground">{t("invite_ask_new")}</p>
        <Button asChild variant="outline" className="mt-4 w-full">
          <Link href="/login">{t("back_to_login")}</Link>
        </Button>
      </AuthShell>
    );
  }
  const user = await getCurrentUser();
  const description = t("invite_description", { inviter: inv.inviterName ?? t("invite_someone"), tenant: inv.tenantName, role: tr(inv.role) });
  const next = `/invite/${token}`;
  if (user && user.id !== inv.existingUserId)
    return (
      <AuthShell title={t("invite_title")} description={description} testId="invite-other-account">
        <p className="text-sm">{t("invite_other_account", { email: user.email, invited: inv.email })}</p>
        <SignOutAndReturnButton next={next} />
      </AuthShell>
    );
  if (user)
    return (
      <AuthShell title={t("invite_title")} description={description} testId="invite-existing">
        <AcceptAsUserButton token={token} tenantName={inv.tenantName} />
      </AuthShell>
    );
  if (inv.existingUserId)
    return (
      <AuthShell title={t("invite_title")} description={description} testId="invite-sign-in">
        <p className="text-sm">{t("invite_sign_in", { email: inv.email })}</p>
        <Button asChild className="mt-4 w-full">
          <Link href={`/login?next=${encodeURIComponent(next)}&email=${encodeURIComponent(inv.email)}`}>{t("invite_sign_in_cta")}</Link>
        </Button>
      </AuthShell>
    );
  return (
    <AuthShell title={t("invite_title")} description={description} testId="invite-new">
      <AcceptInvitationForm token={token} email={inv.email} name={inv.name} privacyUrl={process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL?.trim() || null} />
    </AuthShell>
  );
}

export default withIntl(InvitePage, "app/(auth)/invite/[token]/page.tsx");
