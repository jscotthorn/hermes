import { Module } from '@nestjs/common';
import { BedrockService } from './services/bedrock.service';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [
    BedrockService,
  ],
  exports: [BedrockService],
})
export class BedrockModule { }
