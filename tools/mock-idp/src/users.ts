// The four synthetic test users of the e2e mock IdP. They are fixed in code
// and hold no personal data: the emails are on `.invalid` and every ID token
// says `email_verified: false`, so no forge's "verified email in an allowed
// domain" sign-up rule can ever admit them.

export type IdpUser = {
	readonly username: string;
	readonly sub: string;
	readonly name: string;
	readonly email: string;
};

export const USERS: readonly IdpUser[] = [
	{
		username: "e2e-owner",
		sub: "e2e-owner-0001",
		name: "E2E Owner",
		email: "e2e-owner@tartan.invalid",
	},
	{
		username: "e2e-developer",
		sub: "e2e-developer-0001",
		name: "E2E Developer",
		email: "e2e-developer@tartan.invalid",
	},
	{
		username: "e2e-reporter",
		sub: "e2e-reporter-0001",
		name: "E2E Reporter",
		email: "e2e-reporter@tartan.invalid",
	},
	{
		username: "e2e-outsider",
		sub: "e2e-outsider-0001",
		name: "E2E Outsider",
		email: "e2e-outsider@tartan.invalid",
	},
];

export type PersonaName = "owner" | "developer" | "reporter" | "outsider";

export const PERSONAS: readonly PersonaName[] = [
	"owner",
	"developer",
	"reporter",
	"outsider",
];

export const usernameOf = (persona: PersonaName): string => `e2e-${persona}`;

export const userByName = (username: string): IdpUser | undefined =>
	USERS.find((u) => u.username === username);
