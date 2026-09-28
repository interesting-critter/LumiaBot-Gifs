import { config } from '../utils/config';
import type { GuildMember } from 'discord.js';

export class RateLimiterService {
  private lastRequestTimes: Map<string, number> = new Map();
  private rateLimitSeconds: number;

  constructor() {
    this.rateLimitSeconds = config.rateLimit.seconds;
  }

  public setLimitSeconds(seconds: number): void {
    this.rateLimitSeconds = Math.max(1, seconds);
  }

  public getLimitSeconds(): number {
    return this.rateLimitSeconds;
  }

  public isRateLimited(userId: string, member: GuildMember | null | undefined): boolean {
    // 1. Owner is always exempt
    if (userId === config.bot.ownerId) {
      return false;
    }

    // 2. Check if user has an exempt role (by ID or name)
    if (member && member.roles && config.rateLimit.exemptRoles.length > 0) {
      const hasExemptRole = member.roles.cache.some((role) =>
        config.rateLimit.exemptRoles.includes(role.id) ||
        config.rateLimit.exemptRoles.some((exempt) => exempt.toLowerCase() === role.name.toLowerCase())
      );
      if (hasExemptRole) {
        return false;
      }
    }

    const now = Date.now();
    const lastTime = this.lastRequestTimes.get(userId) || 0;
    const windowMs = this.rateLimitSeconds * 1000;

    if (now - lastTime < windowMs) {
      return true; // Rate limited
    }

    this.lastRequestTimes.set(userId, now);
    return false;
  }

  public getExemptRoles(): string[] {
    return config.rateLimit.exemptRoles;
  }
}

export const rateLimiterService = new RateLimiterService();
