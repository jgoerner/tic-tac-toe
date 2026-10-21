import { Stack, StackProps } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codeconnections from 'aws-cdk-lib/aws-codeconnections';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const NODE_IMAGE = 'node:24.21';
const CYPRESS_IMAGE =
  'cypress/browsers:node-24.21.0-chrome-153.0.8010.36-1-ff-156.0-edge-153.0.4234.32-1';
const UAT_SHARDS = 3;

export interface PipelineStackProps extends StackProps {
  repoOwner: string;
  repoName: string;
  branch: string;
  evidenceBucketName?: string;
}

export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // Created as PENDING; the GitHub app install is a one-time handshake in the console.
    const connection = new codeconnections.CfnConnection(this, 'GitHubConnection', {
      connectionName: 'tic-tac-toe-github',
      providerType: 'GitHub',
    });

    const assumeCdkRoles = new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-${this.region}`],
    });

    const nodeProject = (id: string, command: string, outputs?: Record<string, unknown>) => {
      const project = new codebuild.PipelineProject(this, id, {
        environment: {
          buildImage: codebuild.LinuxBuildImage.fromDockerRegistry(NODE_IMAGE),
          computeType: codebuild.ComputeType.SMALL,
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          env: { variables: { CYPRESS_INSTALL_BINARY: '0' } },
          phases: { build: { commands: [command] } },
          ...(outputs ? { artifacts: outputs } : {}),
        }),
      });
      project.addToRolePolicy(assumeCdkRoles);
      return project;
    };

    const check = nodeProject('Check', 'yarn install --frozen-lockfile && yarn lint && yarn typecheck');
    const build = nodeProject(
      'Build',
      'scripts/ci/build.sh staging && scripts/ci/build.sh production',
      { files: ['**/*'], 'exclude-paths': ['node_modules/**/*'] },
    );
    const synth = nodeProject('InfraCheck', 'yarn install --frozen-lockfile && npx cdk synth --quiet');
    const preview = nodeProject('Preview', 'yarn install --frozen-lockfile && scripts/ci/preview.sh "$TARGET_ENV"');
    const deploy = nodeProject('Deploy', 'yarn install --frozen-lockfile && scripts/ci/deploy.sh "$TARGET_ENV"');

    const uat = new codebuild.PipelineProject(this, 'Uat', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerRegistry(CYPRESS_IMAGE),
        computeType: codebuild.ComputeType.MEDIUM,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        env: { variables: { CYPRESS_BROWSER: 'chrome', SHARD_TOTAL: String(UAT_SHARDS) } },
        phases: {
          install: { commands: ['scripts/ci/install-aws-cli.sh', 'yarn install --frozen-lockfile'] },
          build: {
            commands: [
              `specs="$(find cypress/e2e -name '*.feature' | sort | awk -v n="$SHARD_TOTAL" -v i="$SHARD_INDEX" '(NR - 1) % n == i' | paste -sd, -)"`,
              'echo "This shard runs: ${specs:-<none>}"',
              'if [ -n "$specs" ]; then scripts/ci/run-uat.sh "$TARGET_ENV" "$specs"; fi',
            ],
            finally: ['scripts/ci/upload-evidence.sh "$TARGET_ENV"'],
          },
        },
        reports: {
          uat: { files: ['cypress/results/*.xml'], 'file-format': 'JUNITXML' },
        },
      }),
    });
    uat.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/TicTacToe-*/*`],
      }),
    );
    if (props.evidenceBucketName) {
      s3.Bucket.fromBucketName(this, 'EvidenceBucket', props.evidenceBucketName).grantReadWrite(uat);
    }

    const isRelease = new codepipeline.Variable({
      variableName: 'IS_RELEASE',
      defaultValue: 'false',
      description: 'Upload UAT evidence to S3',
    });

    const source = new codepipeline.Artifact('Source');
    const workspace = new codepipeline.Artifact('Workspace');

    const env = (vars: Record<string, string>) =>
      Object.fromEntries(Object.entries(vars).map(([k, value]) => [k, { value }]));

    const uatActions = (targetEnv: 'staging' | 'production', runOrder: number) =>
      Array.from({ length: UAT_SHARDS }, (_, shard) =>
        new actions.CodeBuildAction({
          actionName: `Uat-${targetEnv}-${shard}`,
          project: uat,
          input: workspace,
          runOrder,
          environmentVariables: env({
            TARGET_ENV: targetEnv,
            SHARD_INDEX: String(shard),
            IS_RELEASE: isRelease.reference(),
            PIPELINE_ID: '#{codepipeline.PipelineExecutionId}',
            ...(props.evidenceBucketName ? { EVIDENCE_BUCKET: props.evidenceBucketName } : {}),
          }),
        }),
      );

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'tic-tac-toe',
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      // The default, SUPERSEDED, lets a newer execution overtake a waiting one; every build must deploy in order.
      executionMode: codepipeline.ExecutionMode.QUEUED,
      variables: [isRelease],
      stages: [
        {
          stageName: 'Source',
          actions: [
            new actions.CodeStarConnectionsSourceAction({
              actionName: 'GitHub',
              connectionArn: connection.attrConnectionArn,
              owner: props.repoOwner,
              repo: props.repoName,
              branch: props.branch,
              output: source,
              codeBuildCloneOutput: true,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new actions.CodeBuildAction({ actionName: 'Check', project: check, input: source, runOrder: 1 }),
            new actions.CodeBuildAction({
              actionName: 'Build',
              project: build,
              input: source,
              outputs: [workspace],
              runOrder: 1,
              environmentVariables: env({ BUILD_NUMBER: '#{codepipeline.PipelineExecutionId}' }),
            }),
            new actions.CodeBuildAction({ actionName: 'InfraCheck', project: synth, input: workspace, runOrder: 2 }),
            new actions.CodeBuildAction({
              actionName: 'PreviewStaging',
              project: preview,
              input: workspace,
              runOrder: 2,
              environmentVariables: env({ TARGET_ENV: 'staging' }),
            }),
          ],
        },
        {
          // The approval sits in this stage so the stage lock holds staging until it is approved or rejected.
          stageName: 'Staging',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'DeployStaging',
              project: deploy,
              input: workspace,
              runOrder: 1,
              environmentVariables: env({ TARGET_ENV: 'staging' }),
            }),
            ...uatActions('staging', 2),
            new actions.CodeBuildAction({
              actionName: 'PreviewProduction',
              project: preview,
              input: workspace,
              runOrder: 2,
              environmentVariables: env({ TARGET_ENV: 'production' }),
            }),
            new actions.ManualApprovalAction({
              actionName: 'ApproveProduction',
              additionalInformation: 'Staging is held for this execution until you approve or reject.',
              runOrder: 3,
            }),
          ],
        },
        {
          stageName: 'Production',
          actions: [
            new actions.CodeBuildAction({
              actionName: 'DeployProduction',
              project: deploy,
              input: workspace,
              runOrder: 1,
              environmentVariables: env({ TARGET_ENV: 'production' }),
            }),
            ...uatActions('production', 2),
          ],
        },
      ],
    });
  }
}
