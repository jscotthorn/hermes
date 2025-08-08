import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MessagePipelineModule } from './modules/message-pipeline/message-pipeline.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BedrockModule } from './modules/bedrock/bedrock.module';
import { EditSessionModule } from './modules/edit-session/edit-session.module';
import GlobalConfiguration from './core/config/global.configuration';
import PromptsConfiguration from './core/config/prompts.configuration';
import { config } from 'dotenv';
import { SqsModule } from '@ssut/nestjs-sqs';

config();

@Module({
  imports: [
    MessagePipelineModule,
    EditSessionModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [GlobalConfiguration, PromptsConfiguration],
    }),
    BedrockModule,
    SqsModule.registerAsync({
      useFactory(configService: ConfigService) {
        const config = configService.get('aws');
        return {
          consumers: [
            {
              // Name is a unique identifier for this consumer instance
              name: config.emailConsumer,
              // The actual SQS queue URL
              queueUrl: `https://sqs.${config.sqsRegion}.amazonaws.com/${config.account}/${config.emailQueue}`,
              region: config.sqsRegion,
            },
          ],
          /*
          producers: [
            {
              // Name is a unique identifier for this producer instance
              name: "hephaestus-content-change-producer",
              // The actual SQS queue URL
              queueUrl: "https://sqs.us-east-2.amazonaws.com/942734823970/hephaestus-content-change",
              region: configService.get('aws.sqsRegion') ?? 'us-east-2',
            },
          ],
          */
        }
      },
      inject: [ConfigService],
      imports: [ConfigModule],
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
