import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BedrockModule } from './modules/bedrock/bedrock.module';
import { EmailProcessorModule } from './modules/email-processor/email-processor.module';
import GlobalConfiguration from './core/config/global.configuration';
import PromptsConfiguration from './core/config/prompts.configuration';
import { config } from 'dotenv';
import { SqsModule } from '@ssut/nestjs-sqs';

config();

@Module({
  imports: [
    EmailProcessorModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [GlobalConfiguration, PromptsConfiguration],
    }),
    BedrockModule,
    SqsModule.registerAsync({
      useFactory(configService: ConfigService) {
        const config = configService.get('aws');

        // In development, use AWS profile from environment
        const sqsOptions: any = {
          region: config.sqsRegion,
        };

        // For local development, we need to ensure credentials are loaded
        if (process.env.NODE_ENV === 'development' && process.env.AWS_PROFILE) {
          // The nestjs-sqs module uses AWS SDK v2, which should pick up
          // credentials from the environment automatically
          console.log(`SQS Module: Using AWS profile '${process.env.AWS_PROFILE}' for development`);
        }

        return {
          consumers: [
            {
              // Name is a unique identifier for this consumer instance
              name: config.emailConsumer,
              // The actual SQS queue URL
              queueUrl: `https://sqs.${config.sqsRegion}.amazonaws.com/${config.account}/${config.emailQueue}`,
              ...sqsOptions,
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
  controllers: [], // No HTTP controllers - pure SQS message processor
  providers: [AppService],
})
export class AppModule { }
