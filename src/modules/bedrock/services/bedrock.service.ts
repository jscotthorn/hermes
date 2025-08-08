// bedrock.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandOutput,
  InferenceConfiguration,
  Message,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockModel } from 'src/core/enum/bedrock-model';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class BedrockService {
  #client: BedrockRuntimeClient;

  constructor(private configService: ConfigService) {
    this.#client = new BedrockRuntimeClient({
      region: this.configService.get('aws.bedrockRegion') ?? 'us-east-1',
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
    })
  }

  async runConfiguredPrompt(confName: string, text: string) {
    const config = this.configService.get(confName);
    if (config == null) {
      throw new InternalServerErrorException('No configuration found');
    }
    return this.invokeConverseCommand(config.modelId, [...(config.shotExamples ?? []), { role: 'user', content: [{ text }] }], config.system);
  }

  async invokeConverseCommand(
    modelId: BedrockModel = BedrockModel.HAIKU3_5,
    messages: Message[],
    system?: string,
    inferenceConfig: InferenceConfiguration = { temperature: 0, topP: 0.95, maxTokens: 2048 }
  ): Promise<string> {
    const command = new ConverseCommand({
      modelId,
      system: system == null ? undefined : [{ text: system }],
      messages,
      inferenceConfig
    })
    let response: ConverseCommandOutput;

    try {
      response = await this.#client.send(command);
      return response?.output?.message?.content?.[0]?.text ?? '';
    } catch (error) {
      console.error('Invocation error', { error, system, messages, modelId });
      throw new InternalServerErrorException('Error from AWS Bedrock');
    }
  }
}
