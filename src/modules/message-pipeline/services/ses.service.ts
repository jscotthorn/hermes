import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import * as nodemailer from 'nodemailer';

export interface SendEmailOptions {
  to?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  messageId?: string;
}

@Injectable()
export class SESService {
  private sesClient: SESClient;
  private transporter: nodemailer.Transporter;
  private defaultFromEmail: string = 'buddy@webordinary.com';

  constructor(private configService: ConfigService) {
    this.sesClient = new SESClient({
      region: this.configService.get('aws.sesRegion') || 'us-east-2',
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') ?? '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') ?? '',
      },
    });

    // Create nodemailer transporter for easier email formatting
    this.transporter = nodemailer.createTransport({
      SES: { ses: this.sesClient, aws: { SendRawEmailCommand } },
    } as any);
  }

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const mailOptions = {
      from: options.from || this.defaultFromEmail,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
      headers: options.messageId ? {
        'In-Reply-To': options.messageId,
        'References': options.messageId,
      } : undefined,
    };

    try {
      const result = await this.transporter.sendMail(mailOptions);
      console.log('Email sent successfully:', result.messageId);
    } catch (error) {
      console.error('Error sending email:', error);
      throw error;
    }
  }

  async sendRawEmail(rawMessage: string): Promise<void> {
    const command = new SendRawEmailCommand({
      RawMessage: {
        Data: Buffer.from(rawMessage),
      },
    });

    try {
      const result = await this.sesClient.send(command);
      console.log('Raw email sent successfully:', result.MessageId);
    } catch (error) {
      console.error('Error sending raw email:', error);
      throw error;
    }
  }
}