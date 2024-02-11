import { join } from 'path';
import { Stack } from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import {
  CloudFormationInit,
  InitCommand,
  InitConfig,
  InitFile,
  InitPackage,
  InitService,
  Instance,
} from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { GitLabConfig } from '../../config-generator/config-generator';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';

export interface GlCfnInitProps {
  readonly config: GitLabConfig;
  readonly tags?: string[];
  readonly tokenSecret: ISecret;
}

export class GlCfnInit extends Construct {
  public static createInit(
    that: Construct,
    props: GlCfnInitProps
  ): CloudFormationInit {
    const tags = [
      ...(props.tags ?? []),
      Stack.of(that).account,
      Stack.of(that).region,
      'docker',
      'runner',
    ].join(',');

    return CloudFormationInit.fromConfigSets({
      configSets: {
        default: [
          'base',
          'docker',
          'gitlabrunner',
          'gitlabconfig',
          'startgitlab',
        ],
      },
      configs: {
        /**
         * We need different packages:
         *    git jq
         * Then we configure awslogs, so that important logs are getting forwarded
         */
        base: new InitConfig([
          InitPackage.yum('git'),
          InitPackage.yum('jq'),
          InitFile.fromString(
            '/root/.aws/config',
            `[default]
region = ${Stack.of(that).region}`
          ),
        ]),

        /**
         * Docker installation for the gitlab runner to be able to run containers
         */
        docker: new InitConfig([
          InitCommand.shellCommand(
            'sudo amazon-linux-extras install docker -y'
          ),
          InitCommand.shellCommand('sudo service docker start'),
          InitCommand.shellCommand('sudo usermod -a -G docker ec2-user'), // TODO: new user?
        ]),

        /**
         * Installation of gitlab runner
         */
        gitlabrunner: new InitConfig([
          InitCommand.shellCommand(
            'curl https://gitlab-runner-downloads.s3.amazonaws.com/latest/rpm/gitlab-runner_amd64.rpm --output gitlab-runner_amd64.rpm'
          ),
          InitCommand.shellCommand('sudo rpm -i gitlab-runner_amd64.rpm'),
        ]),

        /**
         * Create configuration for the runner
         */
        gitlabconfig: new InitConfig([
          InitFile.fromString(
            '/etc/gitlab-runner/config.toml',
            props.config.generateToml()
          ),
          InitFile.fromAsset(
            '/etc/gitlab-runner/start.sh',
            join(__dirname, '../../', 'scripts/', 'start-runner.sh'),
            {
              mode: '0777',
            }
          ),
          InitCommand.shellCommand(`./etc/gitlab-runner/start.sh ${tags}`, {
            testCmd: 'gitlab-runner status',
            env: {
              SECRET: props.tokenSecret.secretArn,
            },
          }),
        ]),

        /**
         * Register and start the runner
         * Tags are not supported out of the config, and we also need to different values doubled during registration, as it doesn't really support toml configuration
         */
        startgitlab: new InitConfig([
          InitService.enable('gitlab-runner', {
            enabled: true,
            ensureRunning: true,
          }),
        ]),
      },
    });
  }

  /**
   * Adds the aws-cfn-bootstrap package to the user data of the instance.
   * @param target
   */
  public static addAwsCfnBootstrap(target: Instance | AutoScalingGroup) {
    target.addUserData('yum install -y aws-cfn-bootstrap');
  }
}
