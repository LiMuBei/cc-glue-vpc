// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { readdirSync } from 'fs';
import path from 'path';

import { Construct } from 'constructs';
import { App, Fn, TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Vpc } from '@cdktf/provider-aws/lib/vpc';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { RdsCluster } from '@cdktf/provider-aws/lib/rds-cluster';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { SecurityGroupRule } from '@cdktf/provider-aws/lib/security-group-rule';
import { Password } from '@cdktf/provider-random/lib/password';
import { SecretsmanagerSecret } from '@cdktf/provider-aws/lib/secretsmanager-secret';
import { SecretsmanagerSecretVersion } from '@cdktf/provider-aws/lib/secretsmanager-secret-version';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Subnet } from '@cdktf/provider-aws/lib/subnet';
import { DbSubnetGroup } from '@cdktf/provider-aws/lib/db-subnet-group';
import { s3BucketPublicAccessBlock } from '@cdktf/provider-aws';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { GlueJob } from '@cdktf/provider-aws/lib/glue-job';
import { S3Object } from '@cdktf/provider-aws/lib/s3-object';
import { KmsKey } from '@cdktf/provider-aws/lib/kms-key';
import { GlueConnection } from '@cdktf/provider-aws/lib/glue-connection';

class MyStack extends TerraformStack {
  readonly vpc: Vpc;
  readonly rdsCluster: RdsCluster;
  readonly rdsClusterSecret: SecretsmanagerSecret;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    new AwsProvider(this, 'aws', {
      region: 'eu-central-1'
    });

    new RandomProvider(this, 'random');

    // This is the VPC we want to deploy our resources into
    this.vpc = new Vpc(this, 'vpc', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true
    });

    // Create isolated subnets for the RDS database
    const rdsSubnetA = new Subnet(this, 'rds-subnet-a', {
      vpcId: this.vpc.id,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: 'eu-central-1a',
      mapPublicIpOnLaunch: false
    });
    const rdsSubnetB = new Subnet(this, 'rds-subnet-b', {
      vpcId: this.vpc.id,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: 'eu-central-1b',
      mapPublicIpOnLaunch: false
    });

    // This is the S3 bucket where the Glue job script and resources will live
    const glueScriptsBucket = new S3Bucket(this, 'glue-bucket', {
      bucket: 'gluescripts.akasper.codecentric.de'
    });
    // Block public access
    new s3BucketPublicAccessBlock.S3BucketPublicAccessBlock(this, 'glue-bucket-public-access-block', {
      bucket: glueScriptsBucket.bucket,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true
    });

    // This is the security group the Glue job will use to access the RDS database
    const glueSecurityGroup = new SecurityGroup(this, 'glue-security-group', {
      name: 'glue-security-group',
      description: 'Security group for Glue job',
      vpcId: this.vpc.id
    });

    // The RDS master user password
    const rdsMasterUsername = 'gluedbadmin';
    const rdsMasterUserPassword = new Password(this, 'rds-master-user-password', {
      length: 48,
      special: false
    });

    // The RDS cluster
    this.rdsCluster = this.setupRdsCluster(
      [rdsSubnetA.id, rdsSubnetB.id],
      glueSecurityGroup,
      rdsMasterUsername,
      rdsMasterUserPassword.result
    );

    this.rdsClusterSecret = this.setupRdsClusterSecret(
      this.rdsCluster,
      rdsMasterUsername,
      rdsMasterUserPassword.result
    );

    // The Glue job
    this.createGlueJob(glueScriptsBucket, this.rdsCluster, this.rdsClusterSecret, glueSecurityGroup, rdsSubnetA.id);
  }

  private setupRdsCluster(
    subnetIds: string[],
    glueSecurityGroup: SecurityGroup,
    rdsMasterUsername: string,
    rdsMasterUserPassword: string
  ) {
    // This is the security group for the RDS database
    const rdsSecurityGroup = this.setupRdsSecurity(this.vpc, this, glueSecurityGroup);

    // NOTE: we will be using the master user to access the RDS, DO NOT DO THIS IN PRODUCTION!!!

    // RDS subnet group
    const subnetGroup = new DbSubnetGroup(this, 'rds-subnet-group', {
      name: 'rds-subnet-group',
      subnetIds: subnetIds
    });

    // This is the RDS database where the Glue job will write to
    const rdsCluster = new RdsCluster(this, 'rds-cluster', {
      clusterIdentifier: 'rds-cluster',
      engine: 'aurora-postgresql',
      engineMode: 'provisioned',
      engineVersion: '15.2',
      databaseName: 'glue',
      masterUsername: rdsMasterUsername,
      masterPassword: rdsMasterUserPassword,
      vpcSecurityGroupIds: [rdsSecurityGroup.id],
      dbSubnetGroupName: subnetGroup.name,
      skipFinalSnapshot: true
    });

    return rdsCluster;
  }

  private setupRdsClusterSecret(rdsCluster: RdsCluster, rdsMasterUsername: string, rdsMasterUserPassword: string) {
    // Store master user credentials in secrets manager
    const rdsMasterUserSecret = new SecretsmanagerSecret(this, 'rds-master-user-secret', {
      name: 'rds-master-user-secret',
      description: 'RDS master user secret'
    });
    new SecretsmanagerSecretVersion(this, 'rds-master-user-secret-version', {
      secretId: rdsMasterUserSecret.id,
      secretString: JSON.stringify({
        dbClusterIdentifier: rdsCluster.clusterIdentifier,
        password: rdsMasterUserPassword,
        dbName: rdsCluster.databaseName,
        port: 5432,
        host: rdsCluster.endpoint,
        username: rdsMasterUsername
      })
    });

    return rdsMasterUserSecret;
  }

  private setupRdsSecurity(vpc: Vpc, scope: Construct, glueSecurityGroup: SecurityGroup) {
    const rdsSecurityGroup = new SecurityGroup(this, 'rds-security-group', {
      name: 'rds-security-group',
      description: 'Security group for RDS database',
      vpcId: vpc.id
    });

    // Disallow all outbound traffic from the RDS database
    new SecurityGroupRule(scope, `rds-disallow-all-outbound-rule`, {
      securityGroupId: rdsSecurityGroup.id,
      description: 'Disallow all outbound traffic',
      type: 'egress',
      protocol: 'icmp',
      fromPort: 252,
      toPort: 86,
      cidrBlocks: ['255.255.255.255/32']
    });

    // This is the security ingress group rule allowing access to the RDS database from the Glue job
    new SecurityGroupRule(this, 'rds-security-group-rule', {
      type: 'ingress',
      fromPort: 5432,
      toPort: 5432,
      protocol: 'tcp',
      securityGroupId: rdsSecurityGroup.id,
      sourceSecurityGroupId: glueSecurityGroup.id
    });
    // This is the security group egress rule allowing access to the Glue job from the RDS database
    new SecurityGroupRule(this, 'glue-security-group-rule', {
      type: 'egress',
      fromPort: 5432,
      toPort: 5432,
      protocol: 'tcp',
      securityGroupId: rdsSecurityGroup.id,
      sourceSecurityGroupId: glueSecurityGroup.id
    });
    return rdsSecurityGroup;
  }

  private createGlueJob(
    glueScriptsBucket: S3Bucket,
    rdsCluster: RdsCluster,
    rdsMasterUserSecret: SecretsmanagerSecret,
    rdsSecurityGroup: SecurityGroup,
    subnetId: string
  ) {
    const jobPolicyDocument = new DataAwsIamPolicyDocument(this, 'glue-job-policy-document', {
      version: '2012-10-17',
      statement: [
        {
          sid: 'glue-job-allow-s3-access',
          effect: 'Allow',
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [`${glueScriptsBucket.arn}/*`, `${glueScriptsBucket.arn}`]
        },
        {
          sid: 'glue-job-allow-rds-secret-access',
          effect: 'Allow',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [rdsMasterUserSecret.arn]
        }
      ]
    });

    const jobPolicy = new IamPolicy(this, 'glue-job-policy', {
      name: 'glue-job-policy',
      policy: jobPolicyDocument.json
    });

    const jobRole = new IamRole(this, 'glue-job-role', {
      name: 'glue-job-role',
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'glue.amazonaws.com'
            },
            Action: 'sts:AssumeRole'
          }
        ]
      }),
      managedPolicyArns: [jobPolicy.arn, 'arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole']
    });

    const rdsConnection = new GlueConnection(this, 'rds-connection', {
      name: 'rds-connection',
      connectionProperties: {
        JDBC_CONNECTION_URL: `jdbc:postgresql://${rdsCluster.endpoint}/${rdsCluster.databaseName}`,
        JDBC_ENFORCE_SSL: 'true',
        SECRET_ID: rdsMasterUserSecret.id
      },
      physicalConnectionRequirements: {
        availabilityZone: rdsCluster.availabilityZones[0],
        securityGroupIdList: [rdsSecurityGroup.id],
        subnetId: subnetId
      }
    });

    new GlueJob(this, 'glue-job', {
      name: 'glue-job',
      command: {
        name: 'pythonshell',
        pythonVersion: '3.9',
        scriptLocation: `s3://${glueScriptsBucket.id}/generate_data_to_rds.py`
      },
      connections: [rdsConnection.id], // This puts the Glue job in the same VPC as the RDS database
      glueVersion: '3.0',
      maxCapacity: 0.0625,
      executionClass: 'STANDARD',
      defaultArguments: {
        '--enable-metrics': 'true',
        '--job-language': 'python',
        'library-set': 'analytics' // This allows us to use AWSWrangler, Pandas etc. in the Glue job
      },
      roleArn: jobRole.arn,
      timeout: 60
    });
  }

  private uploadJobScripts(bucket: S3Bucket, bucketKey: KmsKey) {
    const dirPath = path.resolve(__dirname, '../../../../glue-jobs');
    const jobScriptFiles = readdirSync(dirPath, {
      withFileTypes: true
    });
    jobScriptFiles.forEach((f) => {
      if (f.isFile()) {
        const filePath = `${dirPath}/${f.name}`;
        new S3Object(this, `job-script-object-${f.name}`, {
          bucket: bucket.id,
          source: filePath,
          key: f.name,
          kmsKeyId: bucketKey.arn,
          sourceHash: Fn.filemd5(filePath)
        });
      }
    });
  }
}

const app = new App();
new MyStack(app, 'glue-vpc-article');
app.synth();
