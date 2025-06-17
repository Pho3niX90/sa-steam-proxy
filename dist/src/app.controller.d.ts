import { Request, Response } from 'express';
import { SteamProxyService } from './steam-proxy.service';
export declare class AppController {
    private readonly steamProxy;
    constructor(steamProxy: SteamProxyService);
    getHealth(res: Response): void;
    getMetrics(): {
        total: number;
        success: number;
        failure: number;
        lastDurationMs: number;
    };
    proxy(req: Request, res: Response): Promise<void>;
    checkRateLimit(): void;
    restart(): void;
}
