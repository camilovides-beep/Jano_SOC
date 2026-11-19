import { Controller, Get, HttpException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PortfolioService } from './portfolio.service';

/** Fotos del portafolio (nombre al azar, imposible de adivinar): las usan la galeria del avatar y el panel. */
@Controller()
export class PortfolioImagesController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get('imagenes/:name')
  image(@Param('name') name: string, @Res() res: Response) {
    const file = this.portfolio.file(name);
    if (!file) throw new HttpException('no encontrado', 404);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file);
  }
}
