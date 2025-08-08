import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { EditSessionService } from '../services/edit-session.service';

@Controller('hermes/api/sessions')
export class EditSessionController {
  constructor(private readonly sessionService: EditSessionService) {}

  @Post('activate')
  async activateSession(
    @Body()
    body: {
      clientId: string;
      userId: string;
      instruction: string;
    },
  ) {
    try {
      const session = await this.sessionService.createSession(
        body.clientId,
        body.userId,
        body.instruction,
      );
      return {
        sessionId: session.sessionId,
        previewUrl: session.previewUrl,
        status: session.status,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to activate session: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':sessionId/status')
  async getSessionStatus(@Param('sessionId') sessionId: string) {
    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      throw new HttpException('Session not found', HttpStatus.NOT_FOUND);
    }

    return {
      status: session.status,
      containerIp: session.containerIp,
      lastActivity: new Date(session.lastActivity).toISOString(),
      previewUrl: session.previewUrl,
    };
  }

  @Post(':sessionId/keepalive')
  async keepAlive(@Param('sessionId') sessionId: string) {
    await this.sessionService.updateSessionActivity(sessionId);
    const session = await this.sessionService.getSession(sessionId);
    
    return {
      ttl: session?.ttl || 0,
      status: session?.status || 'expired',
    };
  }

  @Post(':sessionId/deactivate')
  async deactivateSession(@Param('sessionId') sessionId: string) {
    await this.sessionService.deactivateSession(sessionId);
    return {
      status: 'draining',
      message: 'Session deactivation initiated',
    };
  }

  @Get('client/:clientId')
  async getClientSessions(@Param('clientId') clientId: string) {
    const sessions = await this.sessionService.getActiveSessions(clientId);
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      userId: session.userId,
      status: session.status,
      previewUrl: session.previewUrl,
      lastActivity: new Date(session.lastActivity).toISOString(),
    }));
  }
}